// Package executor runs validated shell commands and returns results.
package executor

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const (
	DefaultTimeout = 30 * time.Second
	MaxOutput      = 256 * 1024 // 256 KB cap on combined stdout+stderr
)

// Result holds the output of a completed command.
type Result struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
	TimedOut   bool   `json:"timed_out,omitempty"`
}

// Run executes cmd via bash with a timeout and returns the result.
// The command is passed as a shell string to /bin/bash -c.
//
// Process-group kill: bash is placed in its own process group (Setpgid).
// When the context deadline fires, the entire group is sent SIGKILL so
// child processes (grep, find, etc.) cannot orphan and run indefinitely.
func Run(command string, timeout time.Duration) Result {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	start := time.Now()
	cmd := exec.CommandContext(ctx, "/bin/bash", "-c", command)

	// Place the child in its own process group so SIGKILL reaches the whole tree.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	// Override the default single-process kill with a process-group kill.
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	elapsed := time.Since(start).Milliseconds()

	result := Result{
		Stdout:     truncate(stdout.String(), MaxOutput),
		Stderr:     truncate(stderr.String(), MaxOutput/4),
		DurationMs: elapsed,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.ExitCode = -1
		result.Stderr = fmt.Sprintf("[timed out after %s]\n%s", timeout, result.Stderr)
		return result
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
			result.Stderr = strings.TrimSpace(result.Stderr + "\n" + err.Error())
		}
	}

	return result
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("\n[... truncated %d bytes]", len(s)-max)
}
