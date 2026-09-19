//go:build linux

package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const terminationGrace = 250 * time.Millisecond

func baseEvidence(execution ComputationExecutionV1) ComputationAttemptEvidenceV1 {
	emptyStdout := newBoundedDigestWriter(0)
	emptyStderr := newBoundedDigestWriter(0)
	return ComputationAttemptEvidenceV1{
		Schema:                    ComputationEvidenceSchema,
		RunID:                     execution.RunID,
		ObligationID:              execution.ObligationID,
		ClaimedRevision:           execution.ClaimedRevision,
		ExecutionGeneration:       execution.ExecutionGeneration,
		ExecutionAuthorityCommit:  execution.ExecutionAuthorityCommit,
		ExecutionCapabilitySHA256: execution.ExecutionCapabilitySHA256,
		ExecutionSpecSHA256:       execution.ExecutionSpecSHA256,
		Outcome:                   "failed",
		StdoutSHA256:              emptyStdout.sha256(),
		StderrSHA256:              emptyStderr.sha256(),
	}
}

func explicitEnvironment(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, key+"="+environment[key])
	}
	return values
}

const confinedDirectoryOpenFlags = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC

func openWorkspaceRoot(workspaceRoot string) (*os.File, error) {
	if !filepath.IsAbs(workspaceRoot) {
		return nil, errors.New("workspace root must be absolute")
	}
	clean := filepath.Clean(workspaceRoot)
	fd, err := syscall.Open(clean, confinedDirectoryOpenFlags, 0)
	if err != nil {
		return nil, fmt.Errorf("open workspace root: %w", err)
	}
	return os.NewFile(uintptr(fd), clean), nil
}

func openConfinedWorkingDirectory(workspaceRoot *os.File, relative string) (*os.File, error) {
	clean := filepath.Clean(relative)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		return nil, errors.New("cwd escapes workspace")
	}

	parentFD := int(workspaceRoot.Fd())
	var current *os.File
	components := strings.Split(clean, string(filepath.Separator))
	if clean == "." {
		components = []string{"."}
	}
	for _, component := range components {
		if component == "" {
			continue
		}
		fd, err := syscall.Openat(parentFD, component, confinedDirectoryOpenFlags, 0)
		if current != nil {
			_ = current.Close()
			current = nil
		}
		if err != nil {
			return nil, fmt.Errorf("open cwd component %q: %w", component, err)
		}
		current = os.NewFile(uintptr(fd), component)
		parentFD = fd
	}
	if current == nil {
		return nil, errors.New("cwd invalid")
	}
	return current, nil
}

func killProcessGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func waitAfterCancellation(command *exec.Cmd, wait <-chan error) error {
	if command.Process == nil {
		return nil
	}
	if err := killProcessGroup(command.Process.Pid, syscall.SIGTERM); err != nil {
		return err
	}

	timer := time.NewTimer(terminationGrace)
	defer timer.Stop()

	var waitErr error
	parentExited := false
	select {
	case waitErr = <-wait:
		parentExited = true
		// The parent exiting does not prove its process group is empty.
		// Give descendants the same grace period before fencing the group.
		<-timer.C
	case <-timer.C:
	}

	if err := killProcessGroup(command.Process.Pid, syscall.SIGKILL); err != nil {
		return err
	}
	if !parentExited {
		waitErr = <-wait
	}
	return waitErr
}

func runProcess(
	ctx context.Context,
	workspaceRoot *os.File,
	taskCredential *TaskCredential,
	supervisor *processSupervisor,
	validated validatedExecution,
) (ComputationAttemptEvidenceV1, error) {
	execution := validated.Execution
	spec := validated.Spec
	evidence := baseEvidence(execution)

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(spec.TimeoutMillis)*time.Millisecond)
	defer cancel()
	if err := runCtx.Err(); err != nil {
		evidence.Outcome = "cancelled"
		evidence.Error = err.Error()
		return evidence, nil
	}

	cwd, err := openConfinedWorkingDirectory(workspaceRoot, spec.Cwd)
	if err != nil {
		evidence.Error = err.Error()
		return evidence, nil
	}
	cwdPath := fmt.Sprintf("/proc/self/fd/%d", cwd.Fd())

	stdout := newBoundedDigestWriter(spec.StdoutMaxBytes)
	stderr := newBoundedDigestWriter(spec.StderrMaxBytes)

	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		_ = cwd.Close()
		evidence.Error = fmt.Sprintf("create stdout pipe: %v", err)
		return evidence, nil
	}
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		_ = cwd.Close()
		_ = stdoutRead.Close()
		_ = stdoutWrite.Close()
		evidence.Error = fmt.Sprintf("create stderr pipe: %v", err)
		return evidence, nil
	}

	command := exec.Command(spec.Executable, spec.Argv...)
	command.Dir = cwdPath
	command.Env = explicitEnvironment(spec.Env)
	command.Stdout = stdoutWrite
	command.Stderr = stderrWrite
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGKILL,
	}
	if taskCredential != nil {
		command.SysProcAttr.Credential = &syscall.Credential{
			Uid:         taskCredential.UID,
			Gid:         taskCredential.GID,
			Groups:      []uint32{taskCredential.GID},
			NoSetGroups: false,
		}
	}

	if err := supervisor.start(command); err != nil {
		_ = cwd.Close()
		_ = stdoutRead.Close()
		_ = stdoutWrite.Close()
		_ = stderrRead.Close()
		_ = stderrWrite.Close()
		evidence.Error = fmt.Sprintf("start process: %v", err)
		evidence.StdoutSHA256 = stdout.sha256()
		evidence.StderrSHA256 = stderr.sha256()
		return evidence, nil
	}
	_ = cwd.Close()
	_ = stdoutWrite.Close()
	_ = stderrWrite.Close()

	var capture sync.WaitGroup
	captureErrors := make(chan error, 2)
	capture.Add(2)
	go func() {
		defer capture.Done()
		if _, err := io.Copy(stdout, stdoutRead); err != nil {
			captureErrors <- fmt.Errorf("stdout: %w", err)
		}
	}()
	go func() {
		defer capture.Done()
		if _, err := io.Copy(stderr, stderrRead); err != nil {
			captureErrors <- fmt.Errorf("stderr: %w", err)
		}
	}()

	wait := make(chan error, 1)
	go func() {
		wait <- command.Wait()
	}()

	var waitErr error
	cancelled := false
	select {
	case waitErr = <-wait:
	case <-runCtx.Done():
		cancelled = true
		waitErr = waitAfterCancellation(command, wait)
	}

	hadOrphans, cleanupErr := supervisor.finish(command.Process.Pid)
	if cleanupErr != nil {
		// A containment failure taints this worker. Closing our read ends keeps
		// capture from blocking while the runtime fails the executor lifetime.
		_ = stdoutRead.Close()
		_ = stderrRead.Close()
	}
	capture.Wait()
	close(captureErrors)
	_ = stdoutRead.Close()
	_ = stderrRead.Close()

	var captureErr error
	for err := range captureErrors {
		if captureErr == nil {
			captureErr = err
		}
	}

	evidence.StdoutBase64 = stdout.base64()
	evidence.StdoutSHA256 = stdout.sha256()
	evidence.StdoutTruncated = stdout.truncated()
	evidence.StderrBase64 = stderr.base64()
	evidence.StderrSHA256 = stderr.sha256()
	evidence.StderrTruncated = stderr.truncated()

	if command.ProcessState != nil {
		if status, ok := command.ProcessState.Sys().(syscall.WaitStatus); ok {
			if status.Exited() {
				code := status.ExitStatus()
				evidence.ExitCode = &code
			}
			if status.Signaled() {
				evidence.Signal = status.Signal().String()
			}
		}
	}

	if cleanupErr != nil {
		evidence.Outcome = "failed"
		evidence.Error = fmt.Sprintf("contain task descendants: %v", cleanupErr)
		return evidence, fmt.Errorf("task descendant containment failed: %w", cleanupErr)
	}
	if captureErr != nil {
		evidence.Outcome = "failed"
		evidence.Error = fmt.Sprintf("capture task output: %v", captureErr)
		return evidence, fmt.Errorf("task output capture failed: %w", captureErr)
	}
	if cancelled {
		evidence.Outcome = "cancelled"
		evidence.Error = runCtx.Err().Error()
		return evidence, nil
	}
	if hadOrphans {
		evidence.Outcome = "failed"
		evidence.Error = "task left background descendants after top-level exit"
		return evidence, nil
	}
	if waitErr != nil {
		evidence.Outcome = "failed"
		evidence.Error = waitErr.Error()
		return evidence, nil
	}
	evidence.Outcome = "completed"
	return evidence, nil
}
