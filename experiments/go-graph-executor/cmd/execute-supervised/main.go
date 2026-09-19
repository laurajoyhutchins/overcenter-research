package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	graphexecutor "overcenter-research/experiments/go-graph-executor"
)

func main() {
	maxConcurrency := flag.Int("concurrency", 8, "maximum concurrently executing envelopes")
	timeout := flag.Duration("timeout", 30*time.Second, "whole-process timeout")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	envelopes := make(chan graphexecutor.Envelope)
	scanErr := make(chan error, 1)
	go func() {
		defer close(envelopes)
		defer close(scanErr)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			var envelope graphexecutor.Envelope
			if err := json.Unmarshal(scanner.Bytes(), &envelope); err != nil {
				scanErr <- err
				return
			}
			select {
			case envelopes <- envelope:
			case <-ctx.Done():
				return
			}
		}
		if err := scanner.Err(); err != nil {
			scanErr <- err
		}
	}()

	evidence, executeErr := graphexecutor.ExecuteStream(
		ctx,
		envelopes,
		*maxConcurrency,
		graphexecutor.RunSupervisedSubprocess,
	)
	encoder := json.NewEncoder(os.Stdout)
	for evidence != nil || executeErr != nil || scanErr != nil {
		select {
		case item, ok := <-evidence:
			if !ok {
				evidence = nil
				continue
			}
			if err := encoder.Encode(item); err != nil {
				fail(err)
			}
		case err, ok := <-executeErr:
			if !ok {
				executeErr = nil
				continue
			}
			if err != nil {
				fail(err)
			}
		case err, ok := <-scanErr:
			if !ok {
				scanErr = nil
				continue
			}
			if err != nil {
				fail(err)
			}
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
