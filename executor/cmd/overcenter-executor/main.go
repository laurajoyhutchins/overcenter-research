package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	executor "overcenter-research/executor"
)

func main() {
	workspaceRoot := flag.String("workspace-root", "", "absolute task workspace root")
	maxConcurrency := flag.Int("concurrency", 8, "maximum simultaneously admitted computations")
	socketPath := flag.String("socket", "", "Unix socket path for the trusted host connection")
	stdio := flag.Bool("stdio", false, "serve one test/development session over stdin/stdout")
	flag.Parse()

	if (*socketPath == "") == !*stdio {
		fail(errors.New("choose exactly one transport: --socket or --stdio"))
	}

	runtime, err := executor.NewRuntime(*workspaceRoot, *maxConcurrency)
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
	if err := serveUnixSocket(ctx, runtime, *socketPath); err != nil {
		fail(err)
	}
}

func serveUnixSocket(ctx context.Context, runtime *executor.Runtime, socketPath string) error {
	if !filepath.IsAbs(socketPath) {
		return errors.New("socket path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o750); err != nil {
		return err
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	address, err := net.ResolveUnixAddr("unix", socketPath)
	if err != nil {
		return err
	}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		return err
	}
	listener.SetUnlinkOnClose(true)
	defer listener.Close()
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

	// One connection is one executor lifetime. If the authority-side client
	// disappears, Serve cancels local work and this process exits. Recovery
	// starts from durable facts under a fresh execution generation.
	return runtime.Serve(ctx, connection, connection)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
