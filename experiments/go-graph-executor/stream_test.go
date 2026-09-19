package graphexecutor

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestExecuteStreamStartsBeforeInputCloses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	input := make(chan Envelope)
	results, errs := ExecuteStream(ctx, input, 2, RunSynthetic)

	first := envelope(t, 100, SyntheticSpec{DelayMillis: 5, Result: "first"})
	input <- first

	select {
	case result := <-results:
		if result.RunID != first.RunID || result.Outcome != OutcomeCompleted {
			t.Fatalf("unexpected result: %#v", result)
		}
	case err := <-errs:
		if err != nil {
			t.Fatal(err)
		}
		t.Fatal("stream ended before first result")
	case <-time.After(250 * time.Millisecond):
		t.Fatal("executor waited for stream closure before starting work")
	}

	// The authority stream is deliberately still open when the first execution
	// completes. Only now declare there is no more work.
	close(input)

	for range results {
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestExecuteStreamRejectsDuplicateIdentityWithoutExecutingItTwice(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	input := make(chan Envelope, 2)
	duplicate := envelope(t, 101, SyntheticSpec{Result: "once"})
	input <- duplicate
	input <- duplicate
	close(input)

	var calls atomic.Int32
	results, errs := ExecuteStream(ctx, input, 2, func(ctx context.Context, envelope Envelope) ([]byte, error) {
		calls.Add(1)
		return []byte("once"), nil
	})

	for range results {
	}
	var gotErr error
	for err := range errs {
		if err != nil {
			gotErr = err
		}
	}
	if gotErr == nil {
		t.Fatal("expected duplicate identity error")
	}
	if calls.Load() != 1 {
		t.Fatalf("runner calls=%d, want 1", calls.Load())
	}
}

func TestExecuteStreamPreservesCancellationEvidenceForAcceptedWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	input := make(chan Envelope, 4)
	for index := 0; index < 4; index++ {
		input <- envelope(t, 200+index, SyntheticSpec{WaitForCancel: true})
	}
	close(input)

	started := make(chan struct{}, 4)
	runner := func(ctx context.Context, envelope Envelope) ([]byte, error) {
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	results, errs := ExecuteStream(ctx, input, 4, runner)

	for index := 0; index < 4; index++ {
		select {
		case <-started:
		case <-time.After(250 * time.Millisecond):
			t.Fatal("not all accepted jobs reached a worker before cancellation")
		}
	}
	cancel()

	var evidence []Evidence
	for item := range results {
		evidence = append(evidence, item)
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(evidence) != 4 {
		t.Fatalf("evidence=%d, want 4", len(evidence))
	}
	for _, item := range evidence {
		if item.Outcome != OutcomeCancelled {
			t.Fatalf("outcome=%q, want cancelled", item.Outcome)
		}
		if item.OutputBase64 != "" || item.OutputSHA256 != "" {
			t.Fatalf("cancelled work fabricated output: %#v", item)
		}
	}
}
