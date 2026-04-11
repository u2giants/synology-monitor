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
	regexp.MustCompile(`(?i)\bsysteemctl\s+(poweroff|halt|reboot)\b`),
	// Package manager (apt/opkg/pip global installs)
	regexp.MustCompile(`(?i)\bapt(-get)?\s+(install|remove|purge)\b`),
	regexp.MustCompile(`(?i)\bopkg\s+(install|remove)\b`),
	regexp.MustCompile(`(?i)\bpip\s+install\b`),
	regexp.MustCompile(`(?i)\bnpm\s+install\s+-g\b`),
	// Mount destructive operations
	regexp.MustCompile(`(?i)\bumount\s+/volume`),
	regexp.MustCompile(`(?i)\bmount\s+.*--bind.*/volume`),
}

// writePatterns identifies commands that modify state (tier 2+).
// Used to prevent Tier 1 execution of write operations.
var writePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr)\b`),
	regexp.MustCompile(`(?i)\b(echo|printf|tee|cat)\b.*(>)`),   // redirections
	regexp.MustCompile(`(?i)(>>|>\s*\S)`),                       // any output redirect
	regexp.MustCompile(`(?i)\b(sed|awk)\s+(-i|--in-place)\b`),  // in-place edit
	regexp.MustCompile(`(?i)\bsync\b`),
	regexp.MustCompile(`(?i)\b(systemctl|synopkg|synoservicectl)\s+(start|stop|restart|enable|disable)\b`),
	regexp.MustCompile(`(?i)\bdocker\s+(start|stop|restart|rm|create|run|exec)\b`),
	regexp.MustCompile(`(?i)\bdocker\s+compose\s+(up|down|restart|stop|start|rm)\b`),
	regexp.MustCompile(`(?i)\bssh-keygen\b`),
	regexp.MustCompile(`(?i)\bkill\b`),
	regexp.MustCompile(`(?i)\bpkill\b`),
	regexp.MustCompile(`(?i)\bnohup\b`),
	regexp.MustCompile(`(?i)\bat\b`),            // at-job scheduling
	regexp.MustCompile(`(?i)\bcrontab\s+-[el]\b`), // crontab edit/list is write
}

// filePatterns identifies file-system write operations that touch user data.
// These require Tier 3 (approval + preview required).
var filePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)/volume\d+/`),             // any path under a volume
	regexp.MustCompile(`(?i)\b(rm|mv|cp)\b.*\S`),      // file manipulation
	regexp.MustCompile(`(>>?)\s*/volume`),              // redirect into volume
	regexp.MustCompile(`(?i)\brename\b.*\.old\b`),
	regexp.MustCompile(`(?i)/home/\w`),
	regexp.MustCompile(`(?i)/root/`),
}

// Validate checks a command against tier rules.
// It returns an error if the command is hard-blocked or if it
// requires a higher tier than what was requested.
func Validate(command string, requestedTier int) error {
	// 1. Hard-block check — always fails regardless of tier
	for _, re := range hardBlocked {
		if re.MatchString(command) {
			return errors.New("command is hard-blocked: " + re.String())
		}
	}

	// 2. Tier 1: must be read-only
	if requestedTier == TierRead {
		for _, re := range writePatterns {
			if re.MatchString(command) {
				return errors.New("command requires tier 2 or higher (detected write pattern)")
			}
		}
	}

	// 3. Tier 2: may be a service op but must not touch user files
	if requestedTier == TierService {
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
