package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func execToken(t *testing.T, key, command string, tier int, toolName string) string {
	t.Helper()
	expiresAt := time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339)
	payload := fmt.Sprintf("exec-v2\n%s\n%d\n%s\n%s", command, tier, toolName, expiresAt)
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(payload))
	tok := ExecApprovalTokenV2{
		Version: 2, Command: command, Tier: tier, ToolName: toolName,
		ExpiresAt: expiresAt, Signature: fmt.Sprintf("%x", mac.Sum(nil)),
	}
	raw, err := json.Marshal(tok)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func TestUnsignedAbsentOrForgedToolNameCannotLowerEffectiveTier(t *testing.T) {
	const (
		key     = "test-signing-key"
		command = `mv "$src" "$dest"`
		tool    = "rename_file_to_old"
	)
	v := NewVerifier("test-api-key", key)
	token := execToken(t, key, command, 3, tool)

	if err := v.VerifyExecApprovalToken(token, command, 3, tool); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	for _, tc := range []struct {
		name     string
		tier     int
		toolName string
	}{
		{name: "forged lower tier", tier: 2, toolName: tool},
		{name: "absent tool name with lower tier", tier: 2, toolName: ""},
		{name: "forged lower-tier tool", tier: 3, toolName: "restart_nas_api"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := v.VerifyExecApprovalToken(token, command, tc.tier, tc.toolName); err == nil {
				t.Fatal("forged authorization inputs unexpectedly verified")
			}
		})
	}
}

func TestExecApprovalTokenRejectsLegacyUnsignedContext(t *testing.T) {
	const key = "test-signing-key"
	command := `mv "$src" "$dest"`
	expiresAt := time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339)
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(command + "\n" + expiresAt))
	legacy := ApprovalToken{
		Command: command, Tier: 2, ExpiresAt: expiresAt,
		Signature: fmt.Sprintf("%x", mac.Sum(nil)),
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	if err := NewVerifier("test-api-key", key).VerifyExecApprovalToken(token, command, 2, ""); err == nil {
		t.Fatal("legacy token with unsigned tier/tool context unexpectedly verified")
	}
}
