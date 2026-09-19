package graphexecutor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func envelope(t *testing.T, index int, spec SyntheticSpec) Envelope {
	t.Helper()
	specBytes, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	capability := fmt.Sprintf("secret-capability-%d", index)
	capabilityDigest := sha256.Sum256([]byte(capability))
	specDigest := sha256.Sum256(specBytes)
	return Envelope{
		RunID:                     fmt.Sprintf("run-%04d", index),
		ObligationID:              fmt.Sprintf("work-%04d", index),
		ClaimedRevision:           "revision-1",
		ExecutionGeneration:       1,
		ExecutionAuthorityCommit:  fmt.Sprintf("authority-%04d", index),
		ExecutionCapability:       capability,
		ExecutionCapabilitySHA256: hex.EncodeToString(capabilityDigest[:]),
		ExecutionSpecSHA256:       "sha256:" + hex.EncodeToString(specDigest[:]),
		ExecutionSpec:             specBytes,
	}
}

func TestExecuteBoundsPhysicalConcurrency(t *testing.T) {
	envelopes := make([]Envelope, 64)
	for index := range envelopes {
		envelopes[index] = envelope(t, index, SyntheticSpec{Result: fmt.Sprintf("result-%d", index)})
	}

	var active atomic.Int32
	var maximum atomic.Int32
	runner := func(ctx context.Context, envelope Envelope) ([]byte, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			previous := maximum.Load()
			if current <= previous || maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Millisecond):
			return []byte(envelope.ObligationID), nil
		}
	}

	evidence, err := Execute(context.Background(), envelopes, 8, runner)
	if err != nil {
		t.Fatal(err)
	}
	if len(evidence) != len(envelopes) {
		t.Fatalf("evidence=%d", len(evidence))
	}
	if got := maximum.Load(); got > 8 || got < 2 {
		t.Fatalf("observed concurrency=%d", got)
	}
}

func TestCancellationProducesEvidenceForEveryEnvelopeWithoutInventingSuccess(t *testing.T) {
	envelopes := make([]Envelope, 50)
	for index := range envelopes {
		envelopes[index] = envelope(t, index, SyntheticSpec{
			Result:        fmt.Sprintf("result-%d", index),
			WaitForCancel: index >= 25,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	evidence, err := Execute(ctx, envelopes, 50, RunSynthetic)
	if err != nil {
		t.Fatal(err)
	}

	var completed, cancelled int
	for _, item := range evidence {
		switch item.Outcome {
		case OutcomeCompleted:
			completed++
		case OutcomeCancelled:
			cancelled++
			if item.OutputSHA256 != "" || item.OutputBase64 != "" {
				t.Fatalf("cancelled execution fabricated output: %#v", item)
			}
		default:
			t.Fatalf("unexpected outcome %q", item.Outcome)
		}
	}
	if completed != 25 || cancelled != 25 {
		t.Fatalf("completed=%d cancelled=%d", completed, cancelled)
	}
}

func TestInvalidPlanFailsBeforeAnyExecution(t *testing.T) {
	base := envelope(t, 1, SyntheticSpec{Result: "one"})
	tests := []struct {
		name string
		edit func([]Envelope)
	}{
		{
			name: "capability digest mismatch",
			edit: func(plan []Envelope) { plan[0].ExecutionCapabilitySHA256 = strings.Repeat("0", 64) },
		},
		{
			name: "execution spec digest mismatch",
			edit: func(plan []Envelope) { plan[0].ExecutionSpecSHA256 = "sha256:" + strings.Repeat("0", 64) },
		},
		{
			name: "duplicate execution identity",
			edit: func(plan []Envelope) { plan[1] = plan[0] },
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plan := []Envelope{base, envelope(t, 2, SyntheticSpec{Result: "two"})}
			tc.edit(plan)
			var calls atomic.Int32
			_, err := Execute(context.Background(), plan, 2, func(context.Context, Envelope) ([]byte, error) {
				calls.Add(1)
				return []byte("should-not-run"), nil
			})
			if err == nil {
				t.Fatal("expected validation failure")
			}
			if calls.Load() != 0 {
				t.Fatalf("runner calls=%d", calls.Load())
			}
		})
	}
}

func TestEvidenceDoesNotLeakCapabilitySecret(t *testing.T) {
	input := envelope(t, 7, SyntheticSpec{Result: "safe-output"})
	evidence, err := Execute(context.Background(), []Envelope{input}, 1, RunSynthetic)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), input.ExecutionCapability) {
		t.Fatal("execution capability leaked into evidence")
	}
	if evidence[0].ExecutionCapabilitySHA256 != input.ExecutionCapabilitySHA256 {
		t.Fatal("capability digest identity was not preserved")
	}
}
