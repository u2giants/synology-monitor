package collector

// Inline command validator for the custom-metric collector.
//
// custom_metric_schedules contains free-form shell strings sourced from a
// Supabase table. The agent runs them with the service-role key — there is
// no MCP/nas-api validator in this code path. To prevent that side channel
// from being a remote-code-execution vector, every queued command is
// matched against this allow-list before exec.
//
// Allow: read-only diagnostic commands (cat, ls, head, tail, df, du, ps,
// stat, awk/sed/grep without -i, find without -delete/-exec/-fprint, etc.).
// Block: writes, shells (pipe-to-sh/bash), eval, network fetches, file
// system mutation verbs, anything that would otherwise need Tier 2/3 in
// the nas-api validator.

import (
	"errors"
	"regexp"
	"strings"
)

// customCmdHardBlocked are patterns that are NEVER acceptable inside a
// custom_metric_schedules command, regardless of how the rest of the line
// looks. Mirror of nas-api/internal/validator hardBlocked, plus the same
// pipe-to-shell / system-write rules added there.
//
// Note: Go's regexp uses RE2, which does not support lookahead. The output
// redirect check is implemented in code (validateCustomCommand) rather than
// as a single regex.
var customCmdHardBlocked = []*regexp.Regexp{
	// Disk destruction
	regexp.MustCompile(`(?i)\b(mkfs|fdisk|parted|wipefs|flash_eraseall|nandwrite)\b`),
	regexp.MustCompile(`(?i)\bdd\b.*\bof=`),
	// Filesystem mutation verbs
	regexp.MustCompile(`(?i)\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr|setfacl|tar|rsync|dd|truncate)\b`),
	// In-place edits
	regexp.MustCompile(`(?i)\b(sed|awk)\s+(-i|--in-place)\b`),
	// Process control / service control
	regexp.MustCompile(`(?i)\b(kill|pkill|killall|nohup|at|crontab|systemctl|service|synopkg|synoservicectl|synoservice|synosystemctl)\b`),
	// Reboots / shutdowns
	regexp.MustCompile(`(?i)\b(shutdown|reboot|poweroff|halt)\b`),
	// User / package mutation
	regexp.MustCompile(`(?i)\b(useradd|userdel|usermod|groupadd|groupdel|passwd|adduser|deluser)\b`),
	regexp.MustCompile(`(?i)\b(apt|apt-get|dpkg|opkg|pip|pip3|npm|yarn|gem)\s+(install|remove|purge|update|upgrade)\b`),
	// Kernel
	regexp.MustCompile(`(?i)\b(insmod|rmmod|modprobe)\b`),
	// Mount / unmount
	regexp.MustCompile(`(?i)\b(mount|umount)\b`),
	// Pipe-to-shell — RCE pattern
	regexp.MustCompile(`(?i)\|\s*(sh|bash|zsh|ksh|sudo|su|python\d?|perl|ruby|node)\b`),
	// eval / source
	regexp.MustCompile(`(?i)\b(eval|exec|source)\b`),
	// Docker control
	regexp.MustCompile(`(?i)\bdocker\s+(run|create|exec|cp|stop|start|restart|kill|rm|build|push|pull|plugin|network|volume|context|swarm|stack|builder|buildx|compose)\b`),
	// Outbound network. Keeps the surface narrow.
	regexp.MustCompile(`(?i)\b(curl|wget|fetch|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync)\b`),
	// Background / job control
	regexp.MustCompile(`(?i)(^|[^\\&])&\s*$`),
	regexp.MustCompile(`(?i)&disown\b`),
	// awk/sed script escapes — system("…"), getline "cmd | …", popen, etc.
	// Catches `awk 'BEGIN{system("rm -rf /")}'`-style bypass that survives
	// the single-quote strip in the redirect detector below.
	regexp.MustCompile(`(?i)\bsystem\s*\(`),
	regexp.MustCompile(`(?i)\bpopen\s*\(`),
	regexp.MustCompile(`(?i)\bgetline\b`),
}

// safeRedirectStrip removes redirect tokens that are not writes:
//   - N>/dev/null  or  >>/dev/null   (discard output)
//   - N>&M          (fd-to-fd, e.g. 2>&1)
var safeRedirectStrip = regexp.MustCompile(`\d*>>?\s*/dev/null|\d*>&\d*`)

// singleQuoteStrip removes single-quoted strings so an awk/sed pattern
// containing literal `>` (e.g. `awk '$1 > 100 { print }'`) is not flagged
// as an output redirect.
var singleQuoteStrip = regexp.MustCompile(`'[^']*'`)

// stripped output-redirect detector: any remaining `>` after the safe
// forms and quoted strings have been removed is a real write.
var realRedirect = regexp.MustCompile(`>`)

// validateCustomCommand returns nil if the command is acceptable for the
// custom-metric collector, or an error explaining the rejection.
func validateCustomCommand(command string) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return errors.New("empty command")
	}
	if len(cmd) > 4096 {
		return errors.New("command longer than 4096 bytes")
	}
	for _, re := range customCmdHardBlocked {
		if re.MatchString(cmd) {
			return errors.New("command rejected by custom-metric validator: matches hard-block pattern " + re.String())
		}
	}
	// Output redirect check (two-pass since RE2 lacks lookahead).
	scrubbed := singleQuoteStrip.ReplaceAllString(cmd, "")
	scrubbed = safeRedirectStrip.ReplaceAllString(scrubbed, "")
	if realRedirect.MatchString(scrubbed) {
		return errors.New("command rejected by custom-metric validator: output redirect not permitted")
	}
	return nil
}
