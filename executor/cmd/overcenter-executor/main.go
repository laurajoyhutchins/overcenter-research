package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	executor "overcenter-research/executor"
)

func main() {
	workspaceRoot := flag.String("workspace-root", "", "absolute task workspace root")
	maxConcurrency := flag.Int("concurrency", 8, "maximum simultaneously admitted computations")
	flag.Parse()

	runtime, err := executor.NewRuntime(*workspaceRoot, *maxConcurrency)
	if err != nil {
		fail(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runtime.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
