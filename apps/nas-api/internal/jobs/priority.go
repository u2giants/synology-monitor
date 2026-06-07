//go:build linux

package jobs

import (
	"runtime"
	"syscall"
)

// ioprio_set constants (linux/amd64).
const (
	sysIoprioSet       = 251 // amd64 syscall number for ioprio_set
	ioprioWhoProcess   = 1   // IOPRIO_WHO_PROCESS
	ioprioClassIdle    = 3   // IOPRIO_CLASS_IDLE
	ioprioClassShift   = 13
)

// lowerSelf drops CPU niceness and sets idle I/O priority for the CURRENT OS
// thread so the scan yields to active SMB/Drive workloads. It is best-effort:
// any failure is returned for logging but is non-fatal. The caller locks the
// goroutine to its OS thread first, because I/O priority is per-thread on Linux.
func lowerSelf() error {
	runtime.LockOSThread()
	// nice +10 (lower CPU scheduling priority for this thread).
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, 0, 10); err != nil {
		return err
	}
	// ioprio_set(IOPRIO_WHO_PROCESS, 0, IOPRIO_PRIO_VALUE(IDLE, 0)).
	prio := uintptr(ioprioClassIdle << ioprioClassShift)
	if _, _, errno := syscall.Syscall(sysIoprioSet, ioprioWhoProcess, 0, prio); errno != 0 {
		return errno
	}
	return nil
}
