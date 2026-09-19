//go:build linux

package executor

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	prSetChildSubreaper = 36
	orphanCleanupLimit  = 2 * time.Second
)

var errConcurrentOrphanDescendants = errors.New(
	"orphan task descendants observed while other top-level tasks are active",
)

type processSupervisor struct {
	mu     sync.Mutex
	active map[int]struct{}
}

func newProcessSupervisor() (*processSupervisor, error) {
	if err := enableChildSubreaper(); err != nil {
		return nil, err
	}
	return &processSupervisor{active: map[int]struct{}{}}, nil
}

func enableChildSubreaper() error {
	_, _, errno := syscall.Syscall6(
		syscall.SYS_PRCTL,
		uintptr(prSetChildSubreaper),
		uintptr(1),
		0,
		0,
		0,
		0,
	)
	if errno != 0 {
		return fmt.Errorf("enable child subreaper: %w", errno)
	}
	return nil
}

func (supervisor *processSupervisor) start(command *exec.Cmd) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()

	if err := command.Start(); err != nil {
		return err
	}
	supervisor.active[command.Process.Pid] = struct{}{}
	return nil
}

// finish removes one legitimate top-level task from the active set and checks
// for descendants that outlived their task parent.
//
// When no other top-level task remains, every unregistered child belongs to a
// completed attempt and can be killed/reaped safely. When another top-level
// task is still active, an orphan cannot be attributed without inventing
// cross-task authority. The worker is therefore tainted and must terminate.
func (supervisor *processSupervisor) finish(pid int) (bool, error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()

	delete(supervisor.active, pid)
	orphans, err := supervisor.orphanPIDsLocked()
	if err != nil {
		return false, err
	}
	if len(orphans) == 0 {
		return false, nil
	}
	if len(supervisor.active) > 0 {
		return true, errConcurrentOrphanDescendants
	}
	if err := supervisor.cleanupOrphansLocked(orphans); err != nil {
		return true, err
	}
	return true, nil
}

func (supervisor *processSupervisor) orphanPIDsLocked() ([]int, error) {
	children, err := directChildPIDs(os.Getpid())
	if err != nil {
		return nil, err
	}
	orphans := make([]int, 0, len(children))
	for _, pid := range children {
		if _, active := supervisor.active[pid]; !active {
			orphans = append(orphans, pid)
		}
	}
	return orphans, nil
}

func (supervisor *processSupervisor) cleanupOrphansLocked(initial []int) error {
	deadline := time.Now().Add(orphanCleanupLimit)
	orphans := initial

	for len(orphans) > 0 {
		for _, pid := range orphans {
			if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				return fmt.Errorf("kill orphan descendant %d: %w", pid, err)
			}
		}
		if err := reapChildrenUntil(orphans, deadline); err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("orphan descendant cleanup timed out")
		}

		var err error
		orphans, err = supervisor.orphanPIDsLocked()
		if err != nil {
			return err
		}
	}
	return nil
}

func reapChildrenUntil(pids []int, deadline time.Time) error {
	pending := make(map[int]struct{}, len(pids))
	for _, pid := range pids {
		pending[pid] = struct{}{}
	}

	for len(pending) > 0 {
		for pid := range pending {
			var status syscall.WaitStatus
			waited, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
			switch {
			case err == nil && waited == pid:
				delete(pending, pid)
			case err == nil && waited == 0:
			case errors.Is(err, syscall.ECHILD):
				if _, statErr := os.Stat(fmt.Sprintf("/proc/%d", pid)); errors.Is(statErr, os.ErrNotExist) {
					delete(pending, pid)
				} else {
					return fmt.Errorf("lost orphan descendant %d before reap", pid)
				}
			case errors.Is(err, syscall.EINTR):
			default:
				return fmt.Errorf("reap orphan descendant %d: %w", pid, err)
			}
		}
		if len(pending) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("orphan descendant cleanup timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

func directChildPIDs(parentPID int) ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, fmt.Errorf("read proc: %w", err)
	}
	children := make([]int, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read process status %d: %w", pid, err)
		}
		for _, line := range strings.Split(string(status), "\n") {
			if !strings.HasPrefix(line, "PPid:") {
				continue
			}
			ppid, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
			if err != nil {
				return nil, fmt.Errorf("parse parent pid for %d: %w", pid, err)
			}
			if ppid == parentPID {
				children = append(children, pid)
			}
			break
		}
	}
	return children, nil
}
