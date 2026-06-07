//go:build linux

package jobs

import (
	"syscall"
	"time"
	"unsafe"
)

// statx constants (linux/amd64). We only need creation/birth time.
// SYS_STATX is not in the frozen stdlib syscall package, so it is declared here.
const (
	sysStatx          = 332     // amd64 syscall number for statx(2)
	statxBtime        = 0x00000800 // STATX_BTIME
	atSymlinkNoFollow = 0x100      // AT_SYMLINK_NOFOLLOW
)

// atFdCwd is AT_FDCWD (-100). It is a var, not a const, so that the conversion
// to uintptr wraps at runtime instead of failing a constant overflow check.
var atFdCwd = -100

// statxTimestamp mirrors struct statx_timestamp.
type statxTimestamp struct {
	Sec  int64
	Nsec uint32
	_    int32
}

// statxResult mirrors struct statx (256 bytes on current kernels). We declare the
// full layout so the kernel writes into correctly-aligned fields; only Mask and
// Btime are read.
type statxResult struct {
	Mask           uint32
	Blksize        uint32
	Attributes     uint64
	Nlink          uint32
	Uid            uint32
	Gid            uint32
	Mode           uint16
	_              [1]uint16
	Ino            uint64
	Size           uint64
	Blocks         uint64
	AttributesMask uint64
	Atime          statxTimestamp
	Btime          statxTimestamp
	Ctime          statxTimestamp
	Mtime          statxTimestamp
	RdevMajor      uint32
	RdevMinor      uint32
	DevMajor       uint32
	DevMinor       uint32
	MntID          uint64
	DioMemAlign    uint32
	DioOffsetAlign uint32
	_              [12]uint64
}

// statxBtimeOf returns the file's birth time via the statx(2) syscall, without
// following symlinks. ok is false when btime is unavailable (older kernel or a
// filesystem that does not record it), in which case callers fall back to
// max(mtime, ctime). Best-effort: any syscall error returns ok=false.
func statxBtimeOf(path string) (t time.Time, ok bool) {
	p, err := syscall.BytePtrFromString(path)
	if err != nil {
		return time.Time{}, false
	}
	var st statxResult
	_, _, errno := syscall.Syscall6(
		sysStatx,
		uintptr(atFdCwd),
		uintptr(unsafe.Pointer(p)),
		uintptr(atSymlinkNoFollow),
		uintptr(statxBtime),
		uintptr(unsafe.Pointer(&st)),
		0,
	)
	if errno != 0 {
		return time.Time{}, false
	}
	if st.Mask&statxBtime == 0 {
		return time.Time{}, false
	}
	return time.Unix(st.Btime.Sec, int64(st.Btime.Nsec)), true
}
