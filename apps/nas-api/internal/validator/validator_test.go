package validator

import (
	"strings"
	"testing"
)

func TestReadOnlyDiagnosticsStayTierRead(t *testing.T) {
	tests := []struct {
		name    string
		command string
	}{
		{
			name: "scrub status label mentions sync and docker compose docs",
			command: strings.Join([]string{
				"echo '=== RAID SYNC STATUS (/proc/mdstat) ==='",
				"cat /proc/mdstat 2>/dev/null || echo 'mdstat not available'",
				"echo 'No btrfs volumes found - deploy update required (see docker-compose.agent.yml)'",
				"grep -iE 'scrub|check|sync' /host/log/synolog/synostorage.log 2>/dev/null | tail -20 || true",
			}, "\n"),
		},
		{
			name: "scheduled task sqlite select",
			command: strings.Join([]string{
				"echo '=== SCHEDULED TASKS ==='",
				"sqlite3 /host/usr/syno/etc/schedule/synoscheduler.db \"SELECT id, name, type, enable, status FROM task\" 2>/dev/null | head -40",
				"grep -iE 'error|fail|exit [^0]' /host/log/synolog/synoscheduler.log 2>/dev/null | tail -40 || true",
			}, "\n"),
		},
		{
			name: "diskstats awk comparisons and safe stderr redirects",
			command: strings.Join([]string{
				"echo '=== DISK QUEUE DEPTH ==='",
				"cat /proc/diskstats | awk '{if ($4+$8>0) printf \"%-8s reads:%-8d writes:%-8d in_progress:%-4d\\n\", $3, $4, $8, $12}' | grep -E 'sd|md|dm'",
			}, "\n"),
		},
		{
			name: "oom kill label is not a kill command",
			command: strings.Join([]string{
				"echo '=== OOM KILL HISTORY ==='",
				"dmesg -T 2>/dev/null | grep -iE 'oom|killed process|out of memory' | tail -20 || true",
			}, "\n"),
		},
		{
			name:    "read-only docker command",
			command: "docker ps --format 'table {{.Names}}\\t{{.Status}}'",
		},
		{
			name: "compound read-only docker diagnostics",
			command: strings.Join([]string{
				"echo '=== DOCKER STATS SNAPSHOT ==='",
				"docker stats --no-stream --format 'table {{.Name}}\\t{{.BlockIO}}'",
				"cid=abc123",
				"name=$(docker inspect --format '{{.Name}}' \"$cid\" 2>/dev/null)",
				"echo \"$name\"",
			}, "\n"),
		},
		{
			name:    "tee to dev null stays read tier",
			command: "printf data | tee /dev/null",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyTier(tt.command); got != TierRead {
				t.Fatalf("ClassifyTier() = %d, want %d", got, TierRead)
			}
			if err := Validate(tt.command, TierRead); err != nil {
				t.Fatalf("Validate(TierRead) returned error: %v", err)
			}
		})
	}
}

func TestWriteAndUnsafeCommandsStillBlockedOrElevated(t *testing.T) {
	tests := []struct {
		name     string
		command  string
		wantTier int
	}{
		{
			name:     "real output redirect elevates",
			command:  "echo hello > /tmp/validator-test",
			wantTier: TierService,
		},
		{
			name:     "actual sync command elevates",
			command:  "sync",
			wantTier: TierService,
		},
		{
			name:     "tee to file elevates",
			command:  "printf data | tee /tmp/validator-test",
			wantTier: TierService,
		},
		{
			name:     "service restart elevates",
			command:  "/usr/syno/bin/synopkg restart SynologyDrive",
			wantTier: TierService,
		},
		{
			name:     "file chmod on volume is tier three",
			command:  "chmod 600 /volume1/share/file",
			wantTier: TierFile,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyTier(tt.command); got != tt.wantTier {
				t.Fatalf("ClassifyTier() = %d, want %d", got, tt.wantTier)
			}
			if err := Validate(tt.command, TierRead); err == nil {
				t.Fatalf("Validate(TierRead) unexpectedly allowed %q", tt.command)
			}
		})
	}
}

func TestDockerAllowlistStillAppliesToActualDockerCommands(t *testing.T) {
	if err := Validate("echo 'docker-compose.agent.yml is documentation text'", TierRead); err != nil {
		t.Fatalf("quoted docker text should not trigger docker allowlist: %v", err)
	}

	if err := Validate("docker images", TierRead); err == nil {
		t.Fatal("docker images should not be allowed as a read command")
	}

	if err := Validate("images=$(docker images)", TierRead); err == nil {
		t.Fatal("docker images in command substitution should not be allowed")
	}

	if got := ClassifyTier("docker run --rm alpine true"); got != -1 {
		t.Fatalf("docker run ClassifyTier() = %d, want -1", got)
	}

	if got := ClassifyTier("docker compose ls"); got != -1 {
		t.Fatalf("docker compose ls ClassifyTier() = %d, want -1", got)
	}
}
