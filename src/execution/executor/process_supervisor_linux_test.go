//go:build linux

package executor

import (
	"errors"
	"os"
	"syscall"
	"testing"
)

func TestProcessDisappearedTreatsProcExitRacesAsBenign(t *testing.T) {
	for _, err := range []error{
		&os.PathError{Op: "read", Path: "/proc/123/status", Err: syscall.ENOENT},
		&os.PathError{Op: "read", Path: "/proc/123/status", Err: syscall.ESRCH},
	} {
		if !processDisappeared(err) {
			t.Fatalf("process disappearance error was not recognized: %v", err)
		}
	}
}

func TestProcessDisappearedKeepsUnexpectedStatusErrorsFatal(t *testing.T) {
	err := &os.PathError{Op: "read", Path: "/proc/123/status", Err: syscall.EACCES}
	if processDisappeared(err) {
		t.Fatalf("unexpected process-status error was treated as disappearance: %v", err)
	}
	if !errors.Is(err, syscall.EACCES) {
		t.Fatalf("test fixture lost underlying error: %v", err)
	}
}
