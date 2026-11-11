package drift

import (
	"os"
	"path/filepath"
	"testing"
)

func setup(t *testing.T, capEff string) Env {
	t.Helper()
	root := t.TempDir()
	e := Env{
		DevDir: filepath.Join(root, "dev"), ProcStatus: filepath.Join(root, "status"),
		JobsDir: filepath.Join(root, "jobs"), GroupFile: filepath.Join(root, "group"),
		BtrfsVolume: filepath.Join(root, "btrfs"), DockerSock: filepath.Join(root, "sock"),
	}
	for _, d := range []string{e.DevDir, e.JobsDir, e.BtrfsVolume} {
		os.MkdirAll(d, 0o755)
	}
	os.WriteFile(filepath.Join(e.DevDir, "sda"), nil, 0o644)
	os.WriteFile(filepath.Join(e.DevDir, "null"), nil, 0o644)
	os.WriteFile(e.ProcStatus, []byte("Name:\tx\nCapEff:\t"+capEff+"\n"), 0o644)
	os.WriteFile(e.GroupFile, []byte("g:x:1:\n"), 0o644)
	os.WriteFile(e.DockerSock, nil, 0o644)
	return e
}

func find(r Report, name string) Check {
	for _, c := range r.Checks {
		if c.Name == name {
			return c
		}
	}
	return Check{Name: "missing"}
}

// SYS_ADMIN|SYS_PTRACE|SYS_RAWIO plus the docker defaults.
const goodCaps = "00000000a82e25fb"

func TestHealthy(t *testing.T) {
	r := Run(setup(t, goodCaps))
	if !r.OK {
		t.Fatalf("expected ok, got %+v", r)
	}
	if !find(r, "open sda").OK || find(r, "open null").Name != "missing" {
		t.Fatalf("device probing wrong: %+v", r)
	}
}

func TestMissingCapAndPrivileged(t *testing.T) {
	r := Run(setup(t, "00000000a80425fb")) // no SYS_ADMIN/RAWIO/PTRACE
	if r.OK || find(r, "cap SYS_ADMIN").OK {
		t.Fatalf("missing cap not detected: %+v", r)
	}
	r = Run(setup(t, "000001ffffffffff"))
	if r.OK || find(r, "not privileged").OK {
		t.Fatalf("privileged not detected: %+v", r)
	}
}

func TestMissingMountsAndDevices(t *testing.T) {
	e := setup(t, goodCaps)
	os.Remove(filepath.Join(e.DevDir, "sda"))
	os.RemoveAll(e.JobsDir)
	os.Remove(e.GroupFile)
	r := Run(e)
	for _, n := range []string{"block devices present", "jobs mount writable", "group file readable"} {
		if find(r, n).OK {
			t.Fatalf("%s should fail: %+v", n, r)
		}
	}
}
