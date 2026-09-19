package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	executor "overcenter-research/executor"
)

const executorHelloSchema = "overcenter-executor-hello-v1"

var executionContextPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

)

type executorHelloV1 struct {
	Schema                 string `json:"schema"`
	ExecutionContextSHA256 string `json:"execution_context_sha256"`
	ContainmentID          string `json:"containment_id"`
}

func main() {
	workspaceRoot := flag.String("workspace-root", "", "absolute task workspace root")
	maxConcurrency := flag.Int("concurrency", 8, "maximum simultaneously admitted computations")
	socketPath := flag.String("socket", "", "Unix socket path for the trusted host connection")
	socketGID := flag.Int("socket-gid", -1, "optional trusted-host GID for the Unix socket")
	stdio := flag.Bool("stdio", false, "serve one test/development session over stdin/stdout")
	taskUID := flag.Int("task-uid", -1, "UID for untrusted task processes")
	taskGID := flag.Int("task-gid", -1, "GID for untrusted task processes")
	executionContextSHA256 := flag.String(
		"execution-context-sha256",
		"",
		"trusted digest of the immutable execution context",
	)
	containmentID := flag.String(
		"containment-id",
		"",
		"trusted containment-domain identity",
	)
	unsafeSameUID := flag.Bool(
		"unsafe-test-same-uid",
		false,
		"allow test-only execution without dropping task credentials",
	)
	flag.Parse()

	if (*socketPath == "") == !*stdio {
		fail(errors.New("choose exactly one transport: --socket or --stdio"))
	}

	taskCredential, err := resolveTaskCredential(
		*socketPath != "",
		*taskUID,
		*taskGID,
		*socketGID,
		*unsafeSameUID,
	)
	if err != nil {
		fail(err)
	}
	if *socketPath != "" {
		if err := validateExecutorAttestation(*executionContextSHA256, *containmentID); err != nil {
			fail(err)
		}
	}
	runtime, err := executor.NewRuntime(
		*workspaceRoot,
		*maxConcurrency,
		taskCredential,
	)
	if err != nil {
		fail(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *stdio {
		if err := runtime.Serve(ctx, os.Stdin, os.Stdout); err != nil {
			fail(err)
		}
		return
	}
	if err := serveUnixSocket(
		ctx,
		runtime,
		*socketPath,
		*socketGID,
		taskCredential,
		*executionContextSHA256,
		*containmentID,
	); err != nil {
		fail(err)
	}
}

func resolveTaskCredential(
	productionSocket bool,
	taskUID int,
	taskGID int,
	socketGID int,
	unsafeSameUID bool,
) (*executor.TaskCredential, error) {
	const maxCredential = int64(^uint32(0))
	if int64(taskUID) > maxCredential || int64(taskGID) > maxCredential {
		return nil, errors.New("task uid/gid out of range")
	}
	if socketGID < -1 || int64(socketGID) > maxCredential {
		return nil, errors.New("socket gid out of range")
	}
	if unsafeSameUID {
		if productionSocket {
			return nil, errors.New("unsafe same-uid mode is stdio-only")
		}
		if taskUID >= 0 || taskGID >= 0 {
			return nil, errors.New("unsafe same-uid mode cannot also set task credentials")
		}
		return nil, nil
	}
	if taskUID < 0 || taskGID < 0 {
		if productionSocket {
			return nil, errors.New("socket mode requires --task-uid and --task-gid")
		}
		return nil, errors.New("set task credentials or use --unsafe-test-same-uid")
	}
	if taskUID == os.Geteuid() {
		return nil, errors.New("task uid must differ from executor uid")
	}
	if taskGID == os.Getegid() {
		return nil, errors.New("task gid must differ from executor gid")
	}
	if socketGID >= 0 && taskGID == socketGID {
		return nil, errors.New("task gid must differ from trusted socket gid")
	}
	return &executor.TaskCredential{
		UID: uint32(taskUID),
		GID: uint32(taskGID),
	}, nil
}

func validateExecutorAttestation(executionContextSHA256, containmentID string) error {
	if !executionContextPattern.MatchString(executionContextSHA256) {
		return errors.New("socket mode requires valid --execution-context-sha256")
	}
	if containmentID == "" || len([]byte(containmentID)) > 512 || strings.ContainsRune(containmentID, 0) {
		return errors.New("socket mode requires valid --containment-id")
	}
	return nil
}

func validateSocketDirectory(
	socketDirectory string,
	taskCredential *executor.TaskCredential,
) error {
	if taskCredential == nil {
		return errors.New("production socket requires task credentials")
	}
	info, err := os.Lstat(socketDirectory)
	if err != nil {
		return fmt.Errorf("inspect socket directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("socket directory must be a real directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("socket directory ownership unavailable")
	}
	permissions := info.Mode().Perm()
	if uint32(stat.Uid) == taskCredential.UID && permissions&0o200 != 0 {
		return errors.New("task uid must not be able to write socket directory")
	}
	if uint32(stat.Gid) == taskCredential.GID && permissions&0o020 != 0 {
		return errors.New("task gid must not be able to write socket directory")
	}
	if permissions&0o002 != 0 {
		return errors.New("task must not be able to write socket directory through other permissions")
	}
	return nil
}

func serveUnixSocket(
	ctx context.Context,
	runtime *executor.Runtime,
	socketPath string,
	socketGID int,
	taskCredential *executor.TaskCredential,
	executionContextSHA256 string,
	containmentID string,
) error {
	if !filepath.IsAbs(socketPath) {
		return errors.New("socket path must be absolute")
	}
	socketDirectory := filepath.Dir(socketPath)
	if err := os.MkdirAll(socketDirectory, 0o750); err != nil {
		return err
	}
	if err := validateSocketDirectory(socketDirectory, taskCredential); err != nil {
		return err
	}
	if _, err := os.Lstat(socketPath); err == nil {
		return errors.New("socket path already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	address, err := net.ResolveUnixAddr("unix", socketPath)
	if err != nil {
		return err
	}
	oldUmask := syscall.Umask(0o117)
	listener, err := net.ListenUnix("unix", address)
	syscall.Umask(oldUmask)
	if err != nil {
		return err
	}
	listener.SetUnlinkOnClose(true)
	defer listener.Close()
	if socketGID >= 0 {
		if err := os.Chown(socketPath, -1, socketGID); err != nil {
			return err
		}
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		return err
	}

	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	connection, err := listener.AcceptUnix()
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer connection.Close()

	if err := json.NewEncoder(connection).Encode(executorHelloV1{
		Schema:                 executorHelloSchema,
		ExecutionContextSHA256: executionContextSHA256,
		ContainmentID:          containmentID,
	}); err != nil {
		return fmt.Errorf("write executor hello: %w", err)
	}

	// One connection is one executor lifetime. If the authority-side client
	// disappears, Serve cancels local work and this process exits. Recovery
	// starts from durable facts under a fresh execution generation.
	return runtime.Serve(ctx, connection, connection)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
