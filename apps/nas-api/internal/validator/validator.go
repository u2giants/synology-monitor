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

// hardBlocked is a list of patterns that are NEVER permitted regardless of tier.
// These could brick the NAS, destroy data, modify the OS, or lock out admins.
var hardBlocked = []*regexp.Regexp{
	// Disk destruction
	regexp.MustCompile(`(?i)\bmkfs\b`),
	regexp.MustCompile(`(?i)\bfdisk\b`),
	regexp.MustCompile(`(?i)\bparted\b`),
	regexp.MustCompile(`(?i)\bmdadm\s+--fail\b`),
	// Block dd writing TO real block devices (e.g. dd if=/dev/zero of=/dev/sda).
	// dd reading FROM a device to /dev/null (latency test) is intentionally allowed.
	regexp.MustCompile(`(?i)\bdd\b.*\bof=/dev/(?:sd|nvme|md|mmcblk|vd|xvd|hd)`),
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
	// Mount destructive operations
	regexp.MustCompile(`(?i)\bumount\s+/volume`),
	regexp.MustCompile(`(?i)\bmount\s+.*--bind.*/volume`),
	// Docker socket is effectively host-level control, so only a tiny allowlist
	// of monitor-stack actions may use it. Everything else is blocked outright.
	regexp.MustCompile(`(?i)\bdocker\s+(run|create|exec|cp|plugin|network|volume|context|swarm|stack|builder|buildx)\b`),
	// Pipe-to-shell — fetches/inputs that get re-executed as commands are
	// the canonical RCE shape. Block at every tier.
	regexp.MustCompile(`(?i)\|\s*(sh|bash|zsh|ksh|sudo|su)\b`),
	// eval — unconstrained code execution from a string.
	regexp.MustCompile(`(?i)\beval\b`),
	// Writes / file-system mutation pointed at system directories. Even with an
	// approval token, no tier may chmod/chown/cp/mv/tar/rm into /etc, /usr,
	// /boot, /sys, /proc, /lib, /lib64. Reads (cat, ls, head, tail) are not
	// in this list and continue to work.
	regexp.MustCompile(`(?i)\b(chmod|chown|chattr|setfacl|cp|mv|ln)\b[^\n]*\s/etc(\b|/)`),
	regexp.MustCompile(`(?i)\b(chmod|chown|chattr|setfacl|cp|mv|ln)\b[^\n]*\s/usr(\b|/)`),
	regexp.MustCompile(`(?i)\b(chmod|chown|chattr|setfacl|cp|mv|ln)\b[^\n]*\s/boot(\b|/)`),
	regexp.MustCompile(`(?i)\b(chmod|chown|chattr|setfacl|cp|mv|ln)\b[^\n]*\s/sys(\b|/)`),
	regexp.MustCompile(`(?i)\b(chmod|chown|chattr|setfacl|cp|mv|ln)\b[^\n]*\s/proc(\b|/)`),
	regexp.MustCompile(`(?i)\b(chmod|chown|chattr|setfacl|cp|mv|ln)\b[^\n]*\s/lib(64)?(\b|/)`),
	regexp.MustCompile(`(?i)\btar\b[^\n]*\s-C\s+/(etc|usr|boot|sys|proc|lib)(\b|/)`),
	regexp.MustCompile(`(?i)\bfind\b[^\n]*\s/(etc|usr|boot|sys|proc|lib)(\b|/)[^\n]*\s(-delete|-exec)\b`),
}

// safeRedirectRe strips redirect forms that are not writes:
// - N>/dev/null or >>/dev/null  (discard output)
// - N>&M                        (fd-to-fd, e.g. 2>&1)
var (
	safeRedirectRe   = regexp.MustCompile(`\d*>>?\s*/dev/null|\d*>&\d*`)
	singleQuotedRe   = regexp.MustCompile(`'[^']*'`)
	outputRedirectRe = regexp.MustCompile(`>\s*\S`)
)

// hasRealOutputRedirect returns true only when the command redirects output
// to an actual file destination (not /dev/null, not fd-to-fd like 2>&1,
// and not comparison operators inside quoted awk/shell strings).
func hasRealOutputRedirect(command string) bool {
	s := singleQuotedRe.ReplaceAllString(command, "")
	s = safeRedirectRe.ReplaceAllString(s, "")
	return outputRedirectRe.MatchString(s)
}

// writePatterns identifies commands that modify state (tier 2+).
// Used to prevent Tier 1 execution of write operations.
var writePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr)\b`),
	regexp.MustCompile(`(?i)\b(echo|printf|tee|cat)\b.*(>)`),   // redirections
	regexp.MustCompile(`(?i)\b(sed|awk)\s+(-i|--in-place)\b`),  // in-place edit
	regexp.MustCompile(`(?i)\bsync\b`),
	regexp.MustCompile(`(?i)\b(systemctl|synopkg|synoservicectl)\s+(start|stop|restart|enable|disable)\b`),
	regexp.MustCompile(`(?i)\bdocker\s+(start|stop|restart|rm)\b`),
	regexp.MustCompile(`(?i)\bdocker\s+compose\s+(restart|stop|up|pull|build)\b`),
	regexp.MustCompile(`(?i)\bssh-keygen\b`),
	regexp.MustCompile(`(?i)\bkill\b`),
	regexp.MustCompile(`(?i)\bpkill\b`),
	regexp.MustCompile(`(?i)\bnohup\b`),
	regexp.MustCompile(`(?i)\bat\b`),            // at-job scheduling
	regexp.MustCompile(`(?i)\bcrontab\s+-[el]\b`), // crontab edit/list is write
	// DSM WebAPI write operations (package stop/start, backup trigger, task run/enable/disable)
	regexp.MustCompile(`(?i)SYNO\.(Core\.Package|Backup\.Task|Core\.TaskScheduler).*method=(stop|start|run|run_now|trigger|delete|enable|disable)`),
}

// filePatterns identifies file-system write operations that touch user data.
// These require Tier 3 (approval + preview required).
var filePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr)\b.*(/volume\d+/|/home/\w|/root/)`),
	regexp.MustCompile(`(?i)\b(sed|awk)\s+(-i|--in-place)\b.*(/volume\d+/|/home/\w|/root/)`),
	regexp.MustCompile(`(?i)\b(echo|printf|tee|cat)\b.*(>>?|\\|\\s*tee\\s+)(/volume\d+/|/home/\w|/root/)`),
	regexp.MustCompile(`(>>?)\s*/volume`),              // redirect into volume
	regexp.MustCompile(`(>>?)\s*/home/\w`),
	regexp.MustCompile(`(>>?)\s*/root/`),
	regexp.MustCompile(`(?i)\brename\b.*\.old\b`),
}

var (
	allowedServiceCommands = []*regexp.Regexp{
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg restart SynologyDrive$`),
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg restart SynologyDriveShareSync$`),
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg restart HyperBackup$`),
		regexp.MustCompile(`^/(?:host/)?usr/syno/bin/synopkg status [A-Za-z0-9._-]+(?: 2>&1)?(?: \|\| .+)?$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose restart$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose restart nas-api$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose up -d nas-api$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose stop$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose up -d$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose pull$`),
		regexp.MustCompile(`^cd /volume1/docker/synology-monitor-agent && docker compose build --pull$`),
	}

	allowedReadDockerCommands = []*regexp.Regexp{
		regexp.MustCompile(`^(?:timeout \d+ )?(?:/usr/local/bin/)?docker ps --format .+$`),
		regexp.MustCompile(`^docker stats --no-stream --format .+$`),
		regexp.MustCompile(`^docker inspect --format .+$`),
		regexp.MustCompile(`(?s)^for dir in /sys/fs/cgroup/blkio/docker/\*/; do.+docker inspect --format .+$`),
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

	if strings.Contains(command, "docker") {
		if requestedTier == TierRead {
			if !matchesAny(command, allowedReadDockerCommands) {
				return errors.New("docker read command is not in the allowlist")
			}
		} else if requestedTier >= TierService {
			if !matchesAny(command, allowedServiceCommands) {
				return errors.New("service command is not in the allowlist")
			}
		}
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
	cmd := strings.TrimSpace(command)
	if !strings.Contains(cmd, "docker compose") {
		return false
	}
	allowed := []string{
		"docker compose restart",
		"docker compose stop",
		"docker compose up -d",
		"docker compose pull",
		"docker compose build --pull",
	}
	for _, prefix := range allowed {
		if strings.Contains(cmd, prefix) {
			return false
		}
	}
	return true
}
