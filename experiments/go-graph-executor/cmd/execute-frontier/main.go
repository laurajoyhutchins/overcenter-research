package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	graphexecutor "overcenter-research/experiments/go-graph-executor"
)

type Plan struct {
	Executions []graphexecutor.Envelope `json:"executions"`
}

func main() {
	maxConcurrency := flag.Int("concurrency", 8, "maximum concurrently executing envelopes")
	timeout := flag.Duration("timeout", 30*time.Second, "whole-frontier timeout")
	flag.Parse()

	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail(err)
	}
	var plan Plan
	if err := json.Unmarshal(input, &plan); err != nil {
		fail(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	evidence, err := graphexecutor.Execute(ctx, plan.Executions, *maxConcurrency, graphexecutor.RunSynthetic)
	if err != nil {
		fail(err)
	}

	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(evidence); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
