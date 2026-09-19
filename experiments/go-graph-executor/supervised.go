package graphexecutor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

type SubprocessSpec struct {
	Fixture string `json:"fixture"`
	Mode    string `json:"mode"`
	Result  string `json:"result,omitempty"`
	PIDFile string `json:"pid_file,omitempty"`
}

func RunSupervisedSubprocess(ctx context.Context, envelope Envelope) ([]byte, error) {
	var spec SubprocessSpec
	if err := json.Unmarshal(envelope.ExecutionSpec, &spec); err != nil {
		return nil, err
	}
	if spec.Fixture == "" || spec.Mode == "" {
		return nil, fmt.Errorf("invalid subprocess spec")
	}

	node, err := exec.LookPath("node")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(node, spec.Fixture, spec.Mode, spec.Result, spec.PIDFile)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	wait := make(chan error, 1)
	go func() {
		wait <- cmd.Wait()
	}()

	select {
	case err := <-wait:
		if err != nil {
			return nil, fmt.Errorf("child failed: %w stderr=%s", err, stderr.String())
		}
		return stdout.Bytes(), nil
	case <-ctx.Done():
		killProcessGroup(cmd.Process.Pid, syscall.SIGTERM)
		timer := time.NewTimer(50 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-wait:
		case <-timer.C:
			killProcessGroup(cmd.Process.Pid, syscall.SIGKILL)
			<-wait
		}
		return nil, ctx.Err()
	}
}

func killProcessGroup(pid int, signal syscall.Signal) {
	if err := syscall.Kill(-pid, signal); err != nil && err != syscall.ESRCH {
		return
	}
}
