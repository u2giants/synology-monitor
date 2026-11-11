// Package drift is the FUNCTIONAL configuration check for nas-api
// (docs/nas-config-drift.md section 8): it probes what the container can actually
// do — open each block device, hold the expected capabilities, not be privileged,
// see the required mounts — instead of comparing compose text. A textual compare
// passed the original bug (devices listed under volumes: looked fine but granted
// no cgroup access).
package drift

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Linux capability bit numbers.
const (
	capSysRawio  = 17
	capSysPtrace = 19
	capSysAdmin  = 21
)

// Check is one probe result.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Report is the /drift response body.
type Report struct {
	OK     bool    `json:"ok"`
	Checks []Check `json:"checks"`
}

// Env holds the paths probed; tests point them at a temp dir.
type Env struct {
	DevDir      string // "/dev"
	ProcStatus  string // "/proc/self/status"
	JobsDir     string // "/app/data/jobs"
	GroupFile   string // "/host/etc/group"
	BtrfsVolume string // "/btrfs/volume1"
	DockerSock  string // "/var/run/docker.sock"
}

// Default returns the in-container paths.
func Default() Env {
	return Env{"/dev", "/proc/self/status", "/app/data/jobs", "/host/etc/group", "/btrfs/volume1", "/var/run/docker.sock"}
}

var blockDev = regexp.MustCompile(`^(sd[a-z]+|md[0-9]+|nvme[0-9]+(n[0-9]+)?)$`)

// Run executes every probe.
func Run(e Env) Report {
	var checks []Check
	add := func(name string, ok bool, detail string) { checks = append(checks, Check{name, ok, detail}) }

	caps, err := effectiveCaps(e.ProcStatus)
	if err != nil {
		add("capabilities", false, err.Error())
	} else {
		for _, c := range []struct {
			name string
			bit  uint
		}{{"cap SYS_ADMIN", capSysAdmin}, {"cap SYS_PTRACE", capSysPtrace}, {"cap SYS_RAWIO", capSysRawio}} {
			add(c.name, caps&(1<<c.bit) != 0, fmt.Sprintf("CapEff=%#x", caps))
		}
		// A privileged container holds every capability; ours must not.
		full := caps&0xffffffffff == 0xffffffffff
		add("not privileged", !full, fmt.Sprintf("CapEff=%#x", caps))
	}

	entries, err := os.ReadDir(e.DevDir)
	var devs []string
	if err == nil {
		for _, en := range entries {
			if blockDev.MatchString(en.Name()) {
				devs = append(devs, en.Name())
			}
		}
	}
	sort.Strings(devs)
	add("block devices present", len(devs) > 0, strings.Join(devs, " "))
	for _, d := range devs {
		f, err := os.OpenFile(filepath.Join(e.DevDir, d), os.O_RDONLY, 0)
		if err != nil {
			add("open "+d, false, err.Error())
			continue
		}
		f.Close()
		add("open "+d, true, "read-only open succeeded")
	}

	probe := filepath.Join(e.JobsDir, ".drift-probe")
	if err := os.WriteFile(probe, []byte("x"), 0o600); err != nil {
		add("jobs mount writable", false, err.Error())
	} else {
		os.Remove(probe)
		add("jobs mount writable", true, e.JobsDir)
	}
	if _, err := os.ReadFile(e.GroupFile); err != nil {
		add("group file readable", false, err.Error())
	} else {
		add("group file readable", true, e.GroupFile)
	}
	if st, err := os.Stat(e.BtrfsVolume); err != nil || !st.IsDir() {
		add("btrfs volume mounted", false, fmt.Sprint(err))
	} else {
		add("btrfs volume mounted", true, e.BtrfsVolume)
	}
	if _, err := os.Stat(e.DockerSock); err != nil {
		add("docker socket", false, err.Error())
	} else {
		add("docker socket", true, e.DockerSock)
	}

	ok := true
	for _, c := range checks {
		ok = ok && c.OK
	}
	return Report{OK: ok, Checks: checks}
}

func effectiveCaps(path string) (uint64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "CapEff:") {
			return strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line, "CapEff:")), 16, 64)
		}
	}
	return 0, fmt.Errorf("CapEff not found in %s", path)
}
