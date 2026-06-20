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
		{
			name: "live filename glob search stays read tier",
			command: strings.Join([]string{
				"ROOT='/volume1/Share'",
				"PATTERN='*budget*.xls*'",
				"MAX_RESULTS=500",
				"find \"$ROOT\" \\( -path '*/@eaDir/*' -o -path '*/.SynologyWorkingDirectory/*' \\) -prune -o -type f -name \"$PATTERN\" -print 2>/dev/null | head -n \"$MAX_RESULTS\" | while IFS= read -r f; do",
				"  stat -c '%F\t%s bytes\t%y\t%U:%G\t%n' \"$f\" 2>/dev/null || printf '%s\\n' \"$f\"",
				"done",
			}, "\n"),
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

func TestInotifyAndSeafileIgnoreClassification(t *testing.T) {
	// set_inotify_watches: live sysctl + persist to /etc/sysctl.conf must stay
	// tier 2 (service op) — it must NOT be elevated to tier 3 by the new
	// redirect-into-volume filePattern, because /host/etc is not a data volume.
	tier2 := []string{
		"sysctl -w fs.inotify.max_user_watches=1048576 2>&1",
		"sysctl -w fs.inotify.max_user_instances=1024 2>&1",
		`echo "fs.inotify.max_user_watches=1048576" >> /host/etc/sysctl.conf`,
		`sed -i '/fs\.inotify\.max_user_watches/d;/fs\.inotify\.max_user_instances/d' /host/etc/sysctl.conf 2>&1`,
	}
	for _, cmd := range tier2 {
		if got := ClassifyTier(cmd); got != TierService {
			t.Fatalf("ClassifyTier(%q) = %d, want TierService(2)", cmd, got)
		}
		if err := Validate(cmd, TierService); err != nil {
			t.Fatalf("Validate(TierService) rejected %q: %v", cmd, err)
		}
		if err := Validate(cmd, TierRead); err == nil {
			t.Fatalf("Validate(TierRead) unexpectedly allowed write %q", cmd)
		}
	}

	// write_seafile_ignore: a content write into the /btrfs/volumeN writable mount
	// (quoted path with a space) must classify as tier 3 and validate at tier 3.
	tier3 := []string{
		`printf '%s\n' '@eaDir' '#recycle' > '/btrfs/volume1/mac/Decor/Generic Decor/seafile-ignore.txt'`,
		`printf '%s\n' '@eaDir' >> '/volume1/styleguides/seafile-ignore.txt'`,
	}
	for _, cmd := range tier3 {
		if got := ClassifyTier(cmd); got != TierFile {
			t.Fatalf("ClassifyTier(%q) = %d, want TierFile(3)", cmd, got)
		}
		if err := Validate(cmd, TierFile); err != nil {
			t.Fatalf("Validate(TierFile) rejected %q: %v", cmd, err)
		}
		// A content write to a data volume must never be allowed at tier 1 or 2.
		if err := Validate(cmd, TierRead); err == nil {
			t.Fatalf("Validate(TierRead) unexpectedly allowed volume write %q", cmd)
		}
		if err := Validate(cmd, TierService); err == nil {
			t.Fatalf("Validate(TierService) unexpectedly allowed volume write %q", cmd)
		}
	}
}

func TestBlockExplanationIsActionableAndStateless(t *testing.T) {
	// Non-blocked commands get no explanation.
	if got := BlockExplanation("grep -i error /host/log/synolog/synostorage.log"); got != "" {
		t.Fatalf("BlockExplanation on allowed command = %q, want empty", got)
	}

	// The recurring real case: recursive grep on a Drive store. The explanation
	// must say it is permanent/stateless (not a rate/session limit) and point at
	// the alternative, since this string is the only signal an MCP session gets.
	driveGrep := "grep -r ERROR /host/shares/@synologydrive"
	got := BlockExplanation(driveGrep)
	if got == "" {
		t.Fatal("BlockExplanation on blocked drive grep was empty")
	}
	for _, want := range []string{"permanent and stateless", "NOT a rate limit", "log file"} {
		if !strings.Contains(got, want) {
			t.Fatalf("drive-grep explanation missing %q; got: %s", want, got)
		}
	}

	// Every hard-blocked command must produce a non-empty explanation (no silent
	// blocks), and every one must carry the stateless footer.
	for _, cmd := range []string{
		"mkfs.ext4 /dev/sda1",
		"reboot",
		"useradd hacker",
		"pip install requests",
		"docker run --rm alpine true",
	} {
		exp := BlockExplanation(cmd)
		if exp == "" {
			t.Fatalf("hard-blocked %q produced empty explanation", cmd)
		}
		if !strings.Contains(exp, "NOT a rate limit") {
			t.Fatalf("explanation for %q missing stateless footer; got: %s", cmd, exp)
		}
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

	if got := ClassifyTier("cd /volume1/docker/synology-monitor-agent && docker compose restart"); got != -1 {
		t.Fatalf("docker compose restart ClassifyTier() = %d, want -1", got)
	}
}

func TestDSMContainerManagerWebAPIServiceAllowlist(t *testing.T) {
	start := `/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=start name='"synology-monitor-agent"'`
	stop := `/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=stop name='"synology-monitor-agent"'`
	restart := stop + ` && sleep 3 && ` + start

	for _, command := range []string{start, stop, restart} {
		if got := ClassifyTier(command); got != TierService {
			t.Fatalf("ClassifyTier(%q) = %d, want %d", command, got, TierService)
		}
		if err := Validate(command, TierService); err != nil {
			t.Fatalf("Validate(TierService) rejected %q: %v", command, err)
		}
	}

	otherContainer := `/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=stop name='"postgres"'`
	if err := Validate(otherContainer, TierService); err == nil {
		t.Fatal("Validate(TierService) unexpectedly allowed DSM WebAPI stop for an arbitrary container")
	}
}
