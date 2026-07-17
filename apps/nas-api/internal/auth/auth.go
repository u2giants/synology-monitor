// Package auth handles API key verification and approval token signing/verification.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ApprovalToken is embedded in every tier-2 and tier-3 request.
// The web app creates and signs it; the NAS API verifies it before executing.
type ApprovalToken struct {
	Command   string `json:"command"`
	Tier      int    `json:"tier"`
	ExpiresAt string `json:"expires_at"` // RFC3339
	Signature string `json:"signature"`  // hex-encoded HMAC-SHA256
}

// ExecApprovalTokenV2 is used only by POST /exec. Unlike the legacy native-job
// token above, its HMAC binds every authorization input, including the tier and
// named-tool identity used by the validator's declared-minimum policy.
type ExecApprovalTokenV2 struct {
	Version   int    `json:"version"`
	Command   string `json:"command"`
	Tier      int    `json:"tier"`
	ToolName  string `json:"tool_name,omitempty"`
	ExpiresAt string `json:"expires_at"`
	Signature string `json:"signature"`
}

// Verifier holds the shared secrets.
type Verifier struct {
	apiKey     string // bearer token for all requests
	signingKey string // HMAC key for approval tokens
}

func NewVerifier(apiKey, signingKey string) *Verifier {
	return &Verifier{apiKey: apiKey, signingKey: signingKey}
}

// VerifyAPIKey validates the Authorization: Bearer <key> header value.
func (v *Verifier) VerifyAPIKey(bearer string) bool {
	if len(bearer) < 8 {
		return false
	}
	expected := []byte(v.apiKey)
	actual := []byte(bearer)
	if len(expected) != len(actual) {
		// constant-time length comparison workaround
		return subtle.ConstantTimeCompare(expected, actual) == 1
	}
	return subtle.ConstantTimeCompare(expected, actual) == 1
}

// VerifyApprovalToken decodes and validates a base64url-encoded approval token.
func (v *Verifier) VerifyApprovalToken(encoded, command string, tier int) error {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return errors.New("approval token: invalid base64")
	}
	var tok ApprovalToken
	if err := json.Unmarshal(raw, &tok); err != nil {
		return errors.New("approval token: invalid JSON")
	}
	if tok.Command != command {
		return fmt.Errorf("approval token: command mismatch")
	}
	if tok.Tier != tier {
		return fmt.Errorf("approval token: tier mismatch (token=%d request=%d)", tok.Tier, tier)
	}
	exp, err := time.Parse(time.RFC3339, tok.ExpiresAt)
	if err != nil || time.Now().After(exp) {
		return errors.New("approval token: expired or invalid expiry")
	}
	expected := v.sign(tok.Command, tok.ExpiresAt)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(tok.Signature)) != 1 {
		return errors.New("approval token: invalid signature")
	}
	return nil
}

// VerifyExecApprovalToken verifies the versioned /exec token contract. Legacy
// command+expiry tokens are rejected so mixed nas-api/nas-mcp deployments fail
// closed for writes instead of silently losing named-tool enforcement.
func (v *Verifier) VerifyExecApprovalToken(encoded, command string, tier int, toolName string) error {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return errors.New("exec approval token: invalid base64")
	}
	var tok ExecApprovalTokenV2
	if err := json.Unmarshal(raw, &tok); err != nil {
		return errors.New("exec approval token: invalid JSON")
	}
	if tok.Version != 2 {
		return errors.New("exec approval token: unsupported version")
	}
	if tok.Command != command {
		return errors.New("exec approval token: command mismatch")
	}
	if tok.Tier != tier {
		return fmt.Errorf("exec approval token: tier mismatch (token=%d request=%d)", tok.Tier, tier)
	}
	if tok.ToolName != toolName {
		return errors.New("exec approval token: tool_name mismatch")
	}
	exp, err := time.Parse(time.RFC3339, tok.ExpiresAt)
	if err != nil || time.Now().After(exp) {
		return errors.New("exec approval token: expired or invalid expiry")
	}
	expected := v.signExec(tok.Command, tok.Tier, tok.ToolName, tok.ExpiresAt)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(tok.Signature)) != 1 {
		return errors.New("exec approval token: invalid signature")
	}
	return nil
}

func (v *Verifier) sign(command, expiresAt string) string {
	mac := hmac.New(sha256.New, []byte(v.signingKey))
	mac.Write([]byte(command + "\n" + expiresAt))
	return fmt.Sprintf("%x", mac.Sum(nil))
}

func (v *Verifier) signExec(command string, tier int, toolName, expiresAt string) string {
	mac := hmac.New(sha256.New, []byte(v.signingKey))
	mac.Write([]byte(fmt.Sprintf("exec-v2\n%s\n%d\n%s\n%s", command, tier, toolName, expiresAt)))
	return fmt.Sprintf("%x", mac.Sum(nil))
}
