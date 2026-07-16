// Package validator enforces tier rules and the hard-block list.
package validator

import (
	"errors"
	"regexp"
	"strings"
)

// Tier constants mirror the three permission levels.
const (
	TierRead    = 1 // read-only: auto-executes, no approval needed
	TierService = 2 // service ops: restart packages/containers; approval required
	TierFile    = 3 // file ops: touches user data volumes; approval required
)

// driveRecursiveGrep matches a recursive grep/find against a Synology internal
// data store. Extracted to named vars so BlockExplanation can describe exactly
// this case without the pattern drifting from the hard-block below.
var (
	driveRecursiveGrepA = regexp.MustCompile(`(?i)\bgrep\b.*-[a-zA-Z]*[rR][a-zA-Z]*\s.*(@synologydrive|@SynologyDriveShareSync|/var/packages/SynologyDrive)`)
	driveRecursiveGrepB = regexp.MustCompile(`(?i)\bgrep\b.*(@synologydrive|@SynologyDriveShareSync|/var/packages/SynologyDrive).*-[a-zA-Z]*[rR]`)
)

// hardBlocked is a list of patterns that are NEVER permitted regardless of tier.
// These could brick the NAS, destroy data, modify the OS, or lock out admins.
var hardBlocked = []*regexp.Regexp{
	// Disk destruction
	regexp.MustCompile(`(?i)\bmkfs\b`),
	regexp.MustCompile(`(?i)\bfdisk\b`),
	regexp.MustCompile(`(?i)\bparted\b`),
	regexp.MustCompile(`(?i)\bmdadm\s+--fail\b`),
	regexp.MustCompile(`(?i)\bdd\s+if=`),
	regexp.MustCompile(`(?i)\bwipefs\b`),
	// Root filesystem destruction
	regexp.MustCompile(`(?i)\brm\s+(-\S*f\S*\s+)*/?$`),
	regexp.MustCompile(`(?i)\brm\s+(-\S+\s+)*/boot\b`),
	regexp.MustCompile(`(?i)\brm\s+(-\S+\s+)*/usr\b`),
	regexp.MustCompile(`(?i)\brm\s+(-\S+\s+)*/etc\b`),
	// System software — DSM/Synology binaries must not be modified
	regexp.MustCompile(`(?i)(>|>>|tee)\s+/usr/syno`),
	regexp.MustCompile(`(?i)\bsynopkg\s+(install|uninstall|remove)\b`),
	// Firmware / kernel
	regexp.MustCompile(`(?i)\bflash_eraseall\b`),
	regexp.MustCompile(`(?i)\bnandwrite\b`),
	regexp.MustCompile(`(?i)\binsmod\b`),
	regexp.MustCompile(`(?i)\brmmod\b`),
	// Ptrace code-injection vectors — blocked even though CAP_SYS_PTRACE is granted.
	// strace (read-only syscall tracing) remains unblocked and tier-1 executable.
	// gdb/lldb can call arbitrary functions in a traced process via "call system(...)".
	regexp.MustCompile(`(?i)\bgdb\b`),
	regexp.MustCompile(`(?i)\blldb\b`),
	// Destructive hdparm operations — security erase, standby/sleep, write-cache toggle.
	// Safe read flags (-I device identity, -t throughput test) remain unblocked.
	regexp.MustCompile(`(?i)\bhdparm\b.*--security-`),
	regexp.MustCompile(`(?i)\bhdparm\b.*\s-[yYW]\b`),
	// dd writing directly to a device or /proc — would be a memory/disk write vector.
	// dd if= is already blocked above; this adds the of= form.
	regexp.MustCompile(`(?i)\bdd\b.*\bof=/dev/`),
	regexp.MustCompile(`(?i)\bdd\b.*\bof=/proc/`),
	// User account manipulation
	regexp.MustCompile(`(?i)\buseradd\b`),
	regexp.MustCompile(`(?i)\buserdel\b`),
	regexp.MustCompile(`(?i)\busermod\b`),
	regexp.MustCompile(`(?i)\bgroupadd\b`),
	regexp.MustCompile(`(?i)\bgroupdel\b`),
	regexp.MustCompile(`(?i)\bpasswd\s+\S`), // passwd <user> but not plain passwd
	// NAS shutdown (use DSM UI for planned maintenance)
	regexp.MustCompile(`(?i)\bshutdown\b`),
	regexp.MustCompile(`(?i)\breboot\b`),
	regexp.MustCompile(`(?i)\bpoweroff\b`),
	regexp.MustCompile(`(?i)\bhalt\b`),
	regexp.MustCompile(`(?i)\bsystemctl\s+(poweroff|halt|reboot)\b`),
	// Package manager (apt/opkg/pip global installs)
	regexp.MustCompile(`(?i)\bapt(-get)?\s+(install|remove|purge)\b`),
	regexp.MustCompile(`(?i)\bopkg\s+(install|remove)\b`),
	regexp.MustCompile(`(?i)\bpip\s+install\b`),
	regexp.MustCompile(`(?i)\bnpm\s+install\s+-g\b`),
	// Recursive grep/find on Synology internal data stores.
	// These directories contain millions of opaque file objects; a recursive
	// grep never returns useful results and will thrash disk I/O for days.
	// Use targeted find -maxdepth or a database query instead.
	driveRecursiveGrepA,
	driveRecursiveGrepB,
	// Mount destructive operations
	regexp.MustCompile(`(?i)\bumount\s+/volume`),
	regexp.MustCompile(`(?i)\bmount\s+.*--bind.*/volume`),
	// Docker socket is effectively host-level control, so only a tiny allowlist
	// of monitor-stack actions may use it. Everything else is blocked outright.
	regexp.MustCompile(`(?i)\bdocker\s+(run|create|cp|plugin|network|volume|context|swarm|stack|builder|buildx)\b`),
}

// safeRedirectRe strips redirect forms that are not writes:
// - N>/dev/null or >>/dev/null  (discard output)
// - N>&M                        (fd-to-fd, e.g. 2>&1)
var (
	safeRedirectRe   = regexp.MustCompile(`\d*>>?\s*/dev/null|\d*>&\d*`)
	outputRedirectRe = regexp.MustCompile(`>\s*\S`)
	actualDockerRe   = regexp.MustCompile(`(?im)(^|[;&|(\$]\s*)(?:/(?:usr/)?(?:local/)?bin/)?docker(\s|$)`)
	dockerInvokeRe   = regexp.MustCompile(`(?i)(?:/(?:usr/)?(?:local/)?bin/)?docker\b.*`)
)

// hasRealOutputRedirect returns true only when the command redirects output
// to an actual file destination (not /dev/null, not fd-to-fd like 2>&1,
// and not comparison operators inside quoted awk/shell strings).
func hasRealOutputRedirect(command string) bool {
	s := stripQuotedStrings(command)
	s = safeRedirectRe.ReplaceAllString(s, "")
	return outputRedirectRe.MatchString(s)
}

func hasActualDockerCommand(command string) bool {
	return actualDockerRe.MatchString(stripQuotedStrings(command))
}

func dockerInvocations(command string) []string {
	clean := stripQuotedStrings(command)
	var invocations []string
	for _, line := range strings.Split(clean, "\n") {
		for _, part := range strings.FieldsFunc(line, func(r rune) bool {
			return r == ';' || r == '&' || r == '|'
		}) {
			if match := dockerInvokeRe.FindString(strings.TrimSpace(part)); match != "" {
				invocation := strings.TrimSpace(match)
				invocation = strings.TrimPrefix(invocation, "/usr/local/bin/")
				invocation = strings.TrimPrefix(invocation, "/usr/bin/")
				invocations = append(invocations, invocation)
			}
		}
	}
	return invocations
}

func dockerInvocationsAllowed(command string, allowed []*regexp.Regexp) bool {
	invocations := dockerInvocations(command)
	if len(invocations) == 0 {
		return true
	}
	for _, invocation := range invocations {
		if !matchesAny(invocation, allowed) {
			return false
		}
	}
	return true
}

func stripQuotedStrings(command string) string {
	var b strings.Builder
	b.Grow(len(command))
	inSingle := false
	inDouble := false
	escaped := false
	for _, r := range command {
		switch {
		case escaped:
			if !inSingle && !inDouble {
				b.WriteRune(r)
			}
			escaped = false
		case r == '\\' && inDouble:
			escaped = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
		case r == '"' && !inSingle:
			inDouble = !inDouble
		case inSingle || inDouble:
			// Quoted text is data or labels, not shell structure.
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// writePatterns identifies commands that modify state (tier 2+).
// Used to prevent Tier 1 execution of write operations.
var writePatterns = []*regexp.Regexp{
	// setfacl rewrites permissions like chmod/chown; getfacl reads and must not match.
	regexp.MustCompile(`(?i)\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr|setfacl)\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)tee\s+(-a\s+)?/(tmp|var|volume\d+|home|root|etc|usr|lib|opt|run|mnt|btrfs)/\S+`),
	regexp.MustCompile(`(?i)\b(sed|awk)\s+(-i|--in-place)\b`), // in-place edit
	regexp.MustCompile(`(?im)(^|[;&|]\s*)sync(\s|$)`),
	regexp.MustCompile(`(?i)\bsysctl\s+-w\b`),
	regexp.MustCompile(`(?i)\bionice\b.*-c`), // ionice -c sets I/O class; plain ionice -p (read) stays tier 1
	regexp.MustCompile(`(?i)\bdd\b.*\bof=`),  // dd writing anywhere (device/proc covered by hard-block above)
	// Mutating btrfs subcommands. Matched by verb so read-only diagnostics
	// (subvolume list, scrub/balance/quota status, filesystem show/usage,
	// device stats, qgroup show) stay tier 1. Without these, a snapshot or
	// even `subvolume delete` classified as read-only and auto-executed.
	regexp.MustCompile(`(?i)\bbtrfs\s+subvolume\s+(create|snapshot|delete)\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+(scrub|balance|replace)\s+(start|cancel|resume)\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+device\s+(add|remove|delete|replace)\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+quota\s+(enable|disable|rescan)\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+qgroup\s+(create|destroy|assign|remove|limit)\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+filesystem\s+(resize|defragment|defrag|label)\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+property\s+set\b`),
	// smartctl -t starts a drive self-test and -X aborts one: both command the
	// device and belong at tier 2. The read flags in use (-A -H -a -i -l, incl.
	// `-l selftest`) do not match, so SMART diagnostics stay tier 1.
	regexp.MustCompile(`(?i)\bsmartctl\b[^;&|]*\s-(t|X)\b`),
	// Output redirection into a data volume — raw `/volumeN` or the nas-api
	// `/btrfs/volumeN` writable mount, with or without quotes around the path.
	// stripQuotedStrings hides a quoted redirect target from hasRealOutputRedirect,
	// so a content write like `printf ... > '/btrfs/volume1/<lib>/seafile-ignore.txt'`
	// would otherwise read as non-write. This (matched against the raw command)
	// guarantees it is seen as a write; the twin filePatterns entry makes it tier 3.
	regexp.MustCompile(`(>>?)\s*['"]?/(btrfs/)?volume\d+/`),
	regexp.MustCompile(`(?i)\b(systemctl|synopkg|synoservicectl)\s+(start|stop|restart|enable|disable)\b`),
	regexp.MustCompile(`(?i)SYNO\.Docker\.Container.*method=(stop|start)`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)docker\s+(start|stop|restart|rm)\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)docker\s+compose\s+(restart|stop|up|pull|build)\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)ssh-keygen\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)kill\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)pkill\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)nohup\b`),
	regexp.MustCompile(`(?im)(^|[;&|]\s*)at\b`),              // at-job scheduling
	regexp.MustCompile(`(?im)(^|[;&|]\s*)crontab\s+-[er]\b`), // crontab edit/remove
	// DSM WebAPI write operations (package stop/start, backup trigger, task run/enable/disable)
	regexp.MustCompile(`(?i)SYNO\.(Core\.Package|Backup\.Task|Core\.TaskScheduler).*method=(stop|start|run|run_now|trigger|delete|enable|disable)`),
}

// filePatterns identifies file-system write operations that touch user data.
// These require Tier 3 (approval + preview required).
var filePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr|setfacl)\b.*(/volume\d+/|/home/\w|/root/)`),
	regexp.MustCompile(`(?i)\b(sed|awk)\s+(-i|--in-place)\b.*(/volume\d+/|/home/\w|/root/)`),
	regexp.MustCompile(`(?i)\b(echo|printf|tee|cat)\b.*(>>?|\\|\\s*tee\\s+)(/volume\d+/|/home/\w|/root/)`),
	regexp.MustCompile(`(>>?)\s*/volume`), // redirect into volume
	regexp.MustCompile(`(>>?)\s*/home/\w`),
	regexp.MustCompile(`(>>?)\s*/root/`),
	// Redirect content into a data volume via the nas-api /btrfs/volumeN writable
	// mount (the per-share /volumeN mounts are read-only), including quoted paths
	// with spaces. The plain `/volume` entries above do not match `/btrfs/volume`.
	regexp.MustCompile(`(>>?)\s*['"]?/(btrfs/)?volume\d+/`),
	regexp.MustCompile(`(?i)\brename\b.*\.old\b`),
	// Destroying a subvolume takes user data or a recovery point with it.
	// Creating one (snapshot/create) stays tier 2 — it is additive, and is the
	// designated pre-change recovery step.
	regexp.MustCompile(`(?i)\bbtrfs\s+subvolume\s+delete\b`),
	regexp.MustCompile(`(?i)\bbtrfs\s+device\s+(remove|delete)\b`),
}

var (
	allowedServiceCommands = []*regexp.Regexp{
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg restart SynologyDrive$`),
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg restart SynologyDriveShareSync$`),
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg restart HyperBackup$`),
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg status [A-Za-z0-9._-]+(?: 2>&1)?(?: \|\| .+)?$`),
		regexp.MustCompile(`^/usr/syno/bin/synowebapi --exec api=SYNO\.Docker\.Container version=1 method=(start|stop) name='"synology-monitor-agent"'$`),
		regexp.MustCompile(`^/usr/syno/bin/synowebapi --exec api=SYNO\.Docker\.Container version=1 method=stop name='"synology-monitor-agent"' && sleep 3 && /usr/syno/bin/synowebapi --exec api=SYNO\.Docker\.Container version=1 method=start name='"synology-monitor-agent"'$`),
	}

	allowedReadDockerCommands = []*regexp.Regexp{
		regexp.MustCompile(`^(?:/usr/local/bin/)?docker ps(\s|$)`),
		regexp.MustCompile(`^docker stats --no-stream`),
		regexp.MustCompile(`^docker inspect`),
		regexp.MustCompile(`^docker logs\b`),
		regexp.MustCompile(`^docker port\b`),
		regexp.MustCompile(`^docker diff\b`),
		regexp.MustCompile(`^docker top\b`),
		regexp.MustCompile(`(?s)^for dir in /sys/fs/cgroup/blkio/docker/\*/; do.+docker inspect`),
	}
)

// Validate checks a command against tier rules.
// It returns an error if the command is hard-blocked or if it
// requires a higher tier than what was requested.
func Validate(command string, requestedTier int) error {
	if disallowedDockerCompose(command) {
		return errors.New("docker compose command is not in the allowlist")
	}

	// 1. Hard-block check — always fails regardless of tier
	for _, re := range hardBlocked {
		if re.MatchString(command) {
			return errors.New("command is hard-blocked: " + re.String())
		}
	}

	if hasActualDockerCommand(command) {
		if requestedTier == TierRead {
			if !dockerInvocationsAllowed(command, allowedReadDockerCommands) {
				return errors.New("docker read command is not in the allowlist")
			}
		} else if requestedTier >= TierService {
			if !matchesAny(command, allowedServiceCommands) && !dockerInvocationsAllowed(command, allowedServiceCommands) {
				return errors.New("service command is not in the allowlist")
			}
		}
	}
	if strings.Contains(command, "SYNO.Docker.Container") && matchesAny(command, []*regexp.Regexp{
		regexp.MustCompile(`(?i)method=(start|stop)`),
	}) && !matchesAny(command, allowedServiceCommands) {
		return errors.New("DSM container service command is not in the allowlist")
	}

	// 2. Tier 1: must be read-only
	if requestedTier == TierRead {
		for _, re := range writePatterns {
			if re.MatchString(command) {
				return errors.New("command requires tier 2 or higher (detected write pattern)")
			}
		}
		if hasRealOutputRedirect(command) {
			return errors.New("command requires tier 2 or higher (detected write pattern)")
		}
	}

	// 3. Tier 2: may be a service op but must not touch user files
	if requestedTier == TierService {
		if strings.Contains(command, "/volume1/") && !strings.Contains(command, "/volume1/docker/synology-monitor-agent") {
			return errors.New("tier 2 commands may not touch user data paths")
		}
		for _, re := range filePatterns {
			if re.MatchString(command) {
				return errors.New("command touches user data and requires tier 3")
			}
		}
	}

	return nil
}

// ClassifyTier returns the minimum tier required for a command.
// The caller (web app issue agent) uses this to decide whether to
// auto-execute (tier 1) or prompt for approval (tier 2/3).
func ClassifyTier(command string) int {
	if disallowedDockerCompose(command) {
		return -1
	}
	for _, re := range hardBlocked {
		if re.MatchString(command) {
			return -1 // never
		}
	}
	isWrite := false
	for _, re := range writePatterns {
		if re.MatchString(command) {
			isWrite = true
			break
		}
	}
	if !isWrite {
		isWrite = hasRealOutputRedirect(command)
	}
	if !isWrite {
		return TierRead
	}
	for _, re := range filePatterns {
		if re.MatchString(command) {
			return TierFile
		}
	}
	return TierService
}

// IsHardBlocked returns true if the command can never be executed.
func IsHardBlocked(command string) bool {
	if disallowedDockerCompose(command) {
		return true
	}
	for _, re := range hardBlocked {
		if re.MatchString(command) {
			return true
		}
	}
	return false
}

// BlockExplanation returns a client-facing reason a command is hard-blocked.
// Unlike Summary (which echoes the command), it states WHY, that the block is
// permanent and stateless, and what to do instead. This is the only signal an
// MCP session receives on a refusal — without it, sessions misread the block as
// a "rate limit" or "session degradation" and give up. Returns "" if the command
// is not hard-blocked.
func BlockExplanation(command string) string {
	if !IsHardBlocked(command) {
		return ""
	}
	// This guard is stateless and pure: the same command is refused identically on
	// every call. It is not a per-session quota and not a degradation symptom.
	const footer = " This block is permanent and stateless — it is NOT a rate limit, quota, or session-degradation symptom, and it fired on the command pattern alone. Retrying it or starting a fresh session will return the exact same result; change the command instead."

	switch {
	case driveRecursiveGrepA.MatchString(command), driveRecursiveGrepB.MatchString(command):
		return "Recursive grep against a Synology internal data store (@synologydrive / @SynologyDriveShareSync / the SynologyDrive package dir) is blocked: these hold millions of opaque objects and one such grep ran 4d11h on production before it was caught. Do this instead: grep a specific named log file non-recursively (e.g. @synologydrive/log/*.log or syncfolder.log), or query the monitoring database for historical data." + footer
	case matchesAny(command, []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(mkfs|fdisk|parted|wipefs|flash_eraseall|nandwrite)\b`),
		regexp.MustCompile(`(?i)\bdd\b.*\b(if=|of=/dev/|of=/proc/)`),
		regexp.MustCompile(`(?i)\bmdadm\s+--fail\b`),
		regexp.MustCompile(`(?i)\bhdparm\b`),
	}):
		return "This is a destructive disk/firmware operation that could brick the NAS or destroy an array, so it is blocked at every tier. There is no safe way to run it through this interface — use the DSM UI for planned maintenance." + footer
	case matchesAny(command, []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(shutdown|reboot|poweroff|halt)\b`),
		regexp.MustCompile(`(?i)\bsystemctl\s+(poweroff|halt|reboot)\b`),
	}):
		return "Powering off or rebooting the NAS is blocked here — do planned maintenance from the DSM UI so the shutdown is graceful." + footer
	case matchesAny(command, []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(useradd|userdel|usermod|groupadd|groupdel)\b`),
		regexp.MustCompile(`(?i)\bpasswd\s+\S`),
	}):
		return "User/group account changes are blocked to avoid locking out admins — manage accounts in DSM Control Panel." + footer
	case matchesAny(command, []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(apt(-get)?|opkg)\s+(install|remove|purge)\b`),
		regexp.MustCompile(`(?i)\bpip\s+install\b`),
		regexp.MustCompile(`(?i)\bnpm\s+install\s+-g\b`),
		regexp.MustCompile(`(?i)\bsynopkg\s+(install|uninstall|remove)\b`),
	}):
		return "Installing or removing packages on the host is blocked — it would mutate the NAS OS outside the monitored deploy path." + footer
	case matchesAny(command, []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bdocker\s+(run|create|cp|plugin|network|volume|context|swarm|stack|builder|buildx)\b`),
	}):
		return "This docker subcommand grants host-level control and is outside the small monitor-stack allowlist, so it is blocked. Use DSM Container Manager WebAPI for container lifecycle operations." + footer
	default:
		return "This command matches a permanent safety rule (it could destroy data, modify the OS/firmware, manage accounts, or take the NAS offline)." + footer
	}
}

// Summary returns a human-readable description of what a command does,
// used for building the approval preview shown to the operator.
func Summary(command string) string {
	cmd := strings.TrimSpace(command)
	if strings.HasPrefix(cmd, "cat ") {
		return "Read file: " + strings.TrimPrefix(cmd, "cat ")
	}
	if strings.Contains(cmd, "synopkg restart") {
		return "Restart Synology package"
	}
	if strings.Contains(cmd, "SYNO.Docker.Container") && strings.Contains(cmd, "method=stop") && strings.Contains(cmd, "method=start") {
		return "Restart DSM-managed container"
	}
	if strings.Contains(cmd, "SYNO.Docker.Container") && strings.Contains(cmd, "method=stop") {
		return "Stop DSM-managed container"
	}
	if strings.Contains(cmd, "SYNO.Docker.Container") && strings.Contains(cmd, "method=start") {
		return "Start DSM-managed container"
	}
	if strings.Contains(cmd, "docker") && strings.Contains(cmd, "restart") {
		return "Restart Docker container"
	}
	if strings.Contains(cmd, "mv ") && strings.Contains(cmd, ".old") {
		return "Rename file to .old (quarantine)"
	}
	return cmd
}

func matchesAny(command string, patterns []*regexp.Regexp) bool {
	for _, re := range patterns {
		if re.MatchString(command) {
			return true
		}
	}
	return false
}

func disallowedDockerCompose(command string) bool {
	return strings.Contains(strings.TrimSpace(command), "docker compose")
}
