package graphexecutor

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

const EvidenceSchema = "overcenter-execution-attempt-evidence-v1"

type Envelope struct {
	RunID                     string          `json:"run_id"`
	ObligationID              string          `json:"obligation_id"`
	ClaimedRevision           string          `json:"claimed_revision"`
	ExecutionGeneration       int             `json:"execution_generation"`
	ExecutionAuthorityCommit  string          `json:"execution_authority_commit"`
	ExecutionCapability       string          `json:"execution_capability"`
	ExecutionCapabilitySHA256 string          `json:"execution_capability_sha256"`
	ExecutionSpecSHA256       string          `json:"execution_spec_sha256"`
	ExecutionSpec             json.RawMessage `json:"execution_spec"`
}

type Outcome string

const (
	OutcomeCompleted Outcome = "completed"
	OutcomeFailed    Outcome = "failed"
	OutcomeCancelled Outcome = "cancelled"
)

type Evidence struct {
	Schema                    string  `json:"schema"`
	RunID                     string  `json:"run_id"`
	ObligationID              string  `json:"obligation_id"`
	ClaimedRevision           string  `json:"claimed_revision"`
	ExecutionGeneration       int     `json:"execution_generation"`
	ExecutionAuthorityCommit  string  `json:"execution_authority_commit"`
	ExecutionCapabilitySHA256 string  `json:"execution_capability_sha256"`
	ExecutionSpecSHA256       string  `json:"execution_spec_sha256"`
	Outcome                   Outcome `json:"outcome"`
	OutputBase64              string  `json:"output_base64,omitempty"`
	OutputSHA256              string  `json:"output_sha256,omitempty"`
	Error                     string  `json:"error,omitempty"`
}

type Runner func(context.Context, Envelope) ([]byte, error)

func Execute(
	ctx context.Context,
	envelopes []Envelope,
	maxConcurrency int,
	runner Runner,
) ([]Evidence, error) {
	if runner == nil {
		return nil, errors.New("runner is required")
	}
	if maxConcurrency <= 0 {
		return nil, errors.New("max concurrency must be positive")
	}
	if err := validatePlan(envelopes); err != nil {
		return nil, err
	}
	if len(envelopes) == 0 {
		return []Evidence{}, nil
	}
	if maxConcurrency > len(envelopes) {
		maxConcurrency = len(envelopes)
	}

	jobs := make(chan Envelope, len(envelopes))
	results := make(chan Evidence, len(envelopes))
	for _, envelope := range envelopes {
		jobs <- envelope
	}
	close(jobs)

	var workers sync.WaitGroup
	for worker := 0; worker < maxConcurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for envelope := range jobs {
				results <- executeOne(ctx, envelope, runner)
			}
		}()
	}

	go func() {
		workers.Wait()
		close(results)
	}()

	evidence := make([]Evidence, 0, len(envelopes))
	for result := range results {
		evidence = append(evidence, result)
	}
	if len(evidence) != len(envelopes) {
		return nil, fmt.Errorf("executor evidence cardinality mismatch: got %d want %d", len(evidence), len(envelopes))
	}
	return evidence, nil
}

func validatePlan(envelopes []Envelope) error {
	seen := make(map[string]struct{}, len(envelopes))
	for index, envelope := range envelopes {
		if err := validateEnvelope(envelope, seen); err != nil {
			return fmt.Errorf("invalid envelope at index %d: %w", index, err)
		}
	}
	return nil
}

func validateEnvelopeDigests(envelope Envelope) error {
	digest := sha256.Sum256([]byte(envelope.ExecutionCapability))
	if hex.EncodeToString(digest[:]) != envelope.ExecutionCapabilitySHA256 {
		return errors.New("execution capability digest mismatch")
	}
	specDigest := sha256.Sum256(envelope.ExecutionSpec)
	if "sha256:"+hex.EncodeToString(specDigest[:]) != envelope.ExecutionSpecSHA256 {
		return errors.New("execution spec digest mismatch")
	}
	return nil
}

func executeOne(ctx context.Context, envelope Envelope, runner Runner) Evidence {
	evidence := Evidence{
		Schema:                    EvidenceSchema,
		RunID:                     envelope.RunID,
		ObligationID:              envelope.ObligationID,
		ClaimedRevision:           envelope.ClaimedRevision,
		ExecutionGeneration:       envelope.ExecutionGeneration,
		ExecutionAuthorityCommit:  envelope.ExecutionAuthorityCommit,
		ExecutionCapabilitySHA256: envelope.ExecutionCapabilitySHA256,
		ExecutionSpecSHA256:       envelope.ExecutionSpecSHA256,
	}

	if err := ctx.Err(); err != nil {
		evidence.Outcome = OutcomeCancelled
		evidence.Error = err.Error()
		return evidence
	}

	output, err := runner(ctx, envelope)
	if err != nil {
		if ctx.Err() != nil {
			evidence.Outcome = OutcomeCancelled
			evidence.Error = ctx.Err().Error()
			return evidence
		}
		evidence.Outcome = OutcomeFailed
		evidence.Error = err.Error()
		return evidence
	}

	outputDigest := sha256.Sum256(output)
	evidence.Outcome = OutcomeCompleted
	evidence.OutputBase64 = base64.StdEncoding.EncodeToString(output)
	evidence.OutputSHA256 = "sha256:" + hex.EncodeToString(outputDigest[:])
	return evidence
}
