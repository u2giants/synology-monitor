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

// These families were absent from writePatterns entirely, so the tools built on
// them (create_prechange_snapshot, start_btrfs_scrub, start/cancel_smart_test,
// the former repair_path_acl) classified tier 1 and auto-executed with no
// approval — `btrfs subvolume delete` among them. Mutating verbs must elevate;
// the read-only diagnostics sharing each binary must stay tier 1.
//
// setfacl and synoacltool are covered here even though no tool builds an ACL
// write any more: both remain reachable as hand-written run_command input, which
// is exactly the path that has to stay gated (AGENTS.md § 12).
func TestMutatingSubcommandsElevate(t *testing.T) {
	writes := []struct {
		name     string
		command  string
		wantTier int
	}{
		{
			name:     "prechange snapshot elevates to service tier",
			command:  `btrfs subvolume snapshot -r '/btrfs/volume1' "$snap" 2>&1 && echo "Snapshot created: $snap"`,
			wantTier: TierService,
		},
		{
			name:     "subvolume delete destroys a recovery point, tier three",
			command:  "btrfs subvolume delete /btrfs/volume1/@prechange_20260716",
			wantTier: TierFile,
		},
		{
			name:     "scrub start elevates",
			command:  "btrfs scrub start /btrfs/volume1",
			wantTier: TierService,
		},
		{
			name:     "scrub cancel elevates",
			command:  "btrfs scrub cancel /btrfs/volume1",
			wantTier: TierService,
		},
		{
			name:     "device delete is tier three",
			command:  "btrfs device delete /dev/sda /volume1",
			wantTier: TierFile,
		},
		{
			name:     "smartctl -t starts a self-test",
			command:  "smartctl -t 'short' '/dev/sda' 2>&1",
			wantTier: TierService,
		},
		{
			name:     "smartctl -X aborts a self-test",
			command:  "smartctl -X /dev/'sda' 2>&1",
			wantTier: TierService,
		},
		{
			name:     "setfacl on a volume path is tier three like chmod",
			command:  "setfacl -m 'u:mac:rwx' '/volume1/mac/Decor' 2>&1",
			wantTier: TierFile,
		},
		// synoacltool is DSM's native ACL binary and the only working ACL-write
		// path on these volumes (POSIX setfacl is not installed at all), so it is
		// what an agent reaches for via run_command. Every mutating verb must
		// elevate; -get must not.
		{
			name:     "synoacltool -add on a volume path is tier three",
			command:  "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -add '/volume1/mac/Decor' 'user:mac:allow:rwxpdDaARWc--:fd--' 2>&1",
			wantTier: TierFile,
		},
		{
			name:     "synoacltool -del on a volume path is tier three",
			command:  "/host/usr/syno/bin/synoacltool -del '/volume1/mac/Decor' 0 2>&1",
			wantTier: TierFile,
		},
		{
			name:     "synoacltool write via the writable btrfs mount is tier three",
			command:  "/host/usr/syno/bin/synoacltool -set '/btrfs/volume1/mac/Decor' 'user:mac:allow:rwx:fd--' 2>&1",
			wantTier: TierFile,
		},
		{
			name:     "unknown future synoacltool verb default-denies rather than failing open",
			command:  "/host/usr/syno/bin/synoacltool -enforce-inherit '/volume1/mac/Decor' 2>&1",
			wantTier: TierFile,
		},
		{
			name:     "synoacltool off a data path still elevates to service tier",
			command:  "/host/usr/syno/bin/synoacltool -add /tmp/scratch 'user:mac:allow:rwx:----'",
			wantTier: TierService,
		},
		{
			name:     "synoacltool -set-owner is a chown and must not pass as a read",
			command:  "/host/usr/syno/bin/synoacltool -set-owner '/volume1/mac/Decor' user mac",
			wantTier: TierFile,
		},
		{
			name:     "synoacltool -utime writes a timestamp despite the stat-like name",
			command:  "/host/usr/syno/bin/synoacltool -utime '/volume1/mac/Decor'",
			wantTier: TierFile,
		},
		{
			name:     "synoacltool -copy writes the destination ACL",
			command:  "/host/usr/syno/bin/synoacltool -copy '/volume1/mac/A' '/volume1/mac/B'",
			wantTier: TierFile,
		},
	}

	for _, tt := range writes {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyTier(tt.command); got != tt.wantTier {
				t.Fatalf("ClassifyTier() = %d, want %d", got, tt.wantTier)
			}
			if err := Validate(tt.command, TierRead); err == nil {
				t.Fatalf("Validate(TierRead) unexpectedly allowed %q", tt.command)
			}
		})
	}

	reads := []string{
		"btrfs subvolume list /btrfs/volume1",
		"btrfs scrub status /volume1",
		"btrfs filesystem usage /volume1",
		"btrfs filesystem show",
		"btrfs device stats /volume1",
		"btrfs balance status /volume1",
		"btrfs quota status /volume1",
		"btrfs qgroup show /volume1",
		"smartctl -a /dev/sda",
		"smartctl -A \"$d\"",
		"smartctl -H \"$d\"",
		"smartctl -i \"$d\"",
		"smartctl -l selftest /dev/sda",
		"smartctl -l error /dev/sda",
		"getfacl '/volume1/mac/Decor'",
		// inspect_path_acl / inspect_effective_permissions. The quoted echo label
		// contains the literal word "synoacltool" with no verb after it: it must be
		// stripped as quoted data, not read as a verbless (mutating) invocation.
		"echo '=== SYNOLOGY ACL (synoacltool) ==='\nLD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get '/volume1/mac/Decor' 2>/dev/null || echo 'synoacltool not available'",
		"LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get '/volume1/mac/Decor' 2>/dev/null",
		// Every remaining inspect-only verb from the live `synoacltool` usage text.
		// These must stay tier 1 or ACL diagnostics silently start demanding
		// approval — the failure mode the "read-only stays tier 1" rule exists for.
		"/host/usr/syno/bin/synoacltool -getace '/volume1/mac/Decor'",
		"/host/usr/syno/bin/synoacltool -get-perm '/volume1/mac/Decor' mac",
		"/host/usr/syno/bin/synoacltool -get-archive '/volume1/mac/Decor'",
		"/host/usr/syno/bin/synoacltool -check '/volume1/mac/Decor'",
		"/host/usr/syno/bin/synoacltool -stat '/volume1/mac/Decor'",
		"/host/usr/syno/bin/synoacltool -lstat '/volume1/mac/Decor'",
	}
	for _, command := range reads {
		t.Run("read stays tier one: "+command, func(t *testing.T) {
			if got := ClassifyTier(command); got != TierRead {
				t.Fatalf("ClassifyTier() = %d, want %d (read-only diagnostic)", got, TierRead)
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

// The `passwd <user>` block is a permanent, every-tier block, and its pattern
// (\bpasswd\s+\S) matches any mention of the account FILE that is followed by
// whitespace — including a newline, since built commands are "\n"-joined. So a
// bare trailing `... /host/etc/passwd` is blocked via the NEXT line, and the
// session gets a misleading "User/group account changes are blocked".
//
// repair_path_ownership must read that file to resolve a NAS user name to a uid.
// It dodges the pattern by globbing — `/host/etc/pass??` — so the literal string
// "passwd" never appears in the command at all. Quoting ('/host/etc/passwd')
// also works, since the next char is then a quote rather than whitespace. Either
// is fine; an unquoted bare path is not.
//
// This test pins the boundary in both directions. If you retune the pattern,
// these cases say what the ownership tools depend on; if you are writing a tool
// that reads the account file, the blocked cases show what will bite you.
// Verified live on edgesynology1 2026-07-16: quoted and globbed forms run, the
// bare unquoted form returns "User/group account changes are blocked".
func TestPasswdBlockDoesNotCatchAccountFileReads(t *testing.T) {
	// Real chown-by-name lookups the ownership tools emit. Must survive.
	allowed := []string{
		// The globbed form repair_path_ownership actually ships (6dcf16c).
		`case "$owner" in *[!0-9]*) uid=$(awk -F: -v n="$owner" '$1==n{print $3; exit}' /host/etc/pass??);; *) uid=$owner;; esac`,
		`[ -r /host/etc/pass?? ] || { echo "ERROR: NAS user database is not mounted under /host/etc"; exit 1; }`,
		`uid=$(awk -F: -v n='admin' '$1==n{print $3; exit}' '/host/etc/passwd')`,
		`awk -F: -v n='SynologyDrive' '$1==n{print $3; exit}' '/host/etc/passwd'` + "\n" + `echo next`,
		`[ -f '/host/etc/passwd' ] || { echo "ERROR: /host/etc/passwd: not mounted."; exit 1; }`,
		`echo "add '/etc/passwd:/host/etc/passwd:ro' to the compose file"`,
		`echo "user 'x' does not exist in '/host/etc/passwd'. Refusing."`,
	}
	for _, cmd := range allowed {
		if IsHardBlocked(cmd) {
			t.Errorf("account-file read must not be hard-blocked: %q\nreason: %s", cmd, BlockExplanation(cmd))
		}
	}

	// The actual account-mutation commands the block exists for. Must stay blocked.
	blocked := []string{
		`passwd admin`,
		`passwd -l root`,
		`useradd bob`,
		`usermod -aG users bob`,
		`groupadd staff`,
		// Unquoted trailing path + newline: the false positive that shipped a
		// misleading "account changes are blocked" error. Still blocked today —
		// tools must quote the path rather than rely on this being fixed.
		`wc -l /host/etc/passwd` + "\n" + `echo next`,
	}
	for _, cmd := range blocked {
		if !IsHardBlocked(cmd) {
			t.Errorf("expected hard block for %q", cmd)
		}
	}
}

// Hard blocks match the raw command string, so a tool's own error/remediation
// PROSE can get that tool's command rejected — the text is not exempt for being
// inside an echo or a quoted string. This bit the ownership-tool rewrite twice:
// advice that named the compose command tripped disallowedDockerCompose, which is
// a bare strings.Contains(cmd, "docker compose") with no quote-stripping.
//
// If you are writing remediation text that has to tell an operator to recreate a
// container, point at DSM Container Manager and the docker-compose.agent.yml
// filename (hyphenated, safe) rather than naming the command.
func TestRemediationProseIsNotSelfBlocking(t *testing.T) {
	safe := []string{
		`echo "Fix: add '/etc/group:/host/etc/group:ro' to the nas-api service in deploy/synology/docker-compose.agent.yml, then recreate the container on this NAS via DSM Container Manager."`,
		`echo "see docs/synology-archive-implementation.md for the one-time mount rollout"`,
	}
	for _, cmd := range safe {
		if IsHardBlocked(cmd) {
			t.Errorf("remediation prose must not block its own command: %q\nreason: %s", cmd, BlockExplanation(cmd))
		}
	}

	// Naming the compose command blocks the whole command, even quoted inside an
	// echo. Documented, not desired — the substring check is deliberately blunt.
	if !IsHardBlocked(`echo "run 'docker compose up -d' on this NAS"`) {
		t.Error("expected quoted 'docker compose' prose to still be hard-blocked; " +
			"if this now passes, the ownership tools' remediation text may be reworded")
	}
}
