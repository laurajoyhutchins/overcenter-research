package graphexecutor

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ExecuteStream consumes individually-authorized execution envelopes as they
// arrive. It deliberately owns no graph, queue, or durable scheduling state.
// Closing envelopes means "no more work in this process"; current authority is
// reconstructed outside this process after a restart.
func ExecuteStream(
	ctx context.Context,
	envelopes <-chan Envelope,
	maxConcurrency int,
	runner Runner,
) (<-chan Evidence, <-chan error) {
	results := make(chan Evidence, max(1, maxConcurrency))
	errs := make(chan error, 1)

	if runner == nil {
		close(results)
		errs <- errors.New("runner is required")
		close(errs)
		return results, errs
	}
	if maxConcurrency <= 0 {
		close(results)
		errs <- errors.New("max concurrency must be positive")
		close(errs)
		return results, errs
	}

	jobs := make(chan Envelope, maxConcurrency)
	var workers sync.WaitGroup
	for worker := 0; worker < maxConcurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for envelope := range jobs {
				result := executeOne(ctx, envelope, runner)
				results <- result
			}
		}()
	}

	go func() {
		defer close(errs)
		seen := map[string]struct{}{}
		for {
			select {
			case <-ctx.Done():
				close(jobs)
				workers.Wait()
				close(results)
				return
			case envelope, ok := <-envelopes:
				if !ok {
					close(jobs)
					workers.Wait()
					close(results)
					return
				}
				if err := validateEnvelope(envelope, seen); err != nil {
					errs <- err
					close(jobs)
					workers.Wait()
					close(results)
					return
				}
				select {
				case jobs <- envelope:
				case <-ctx.Done():
					close(jobs)
					workers.Wait()
					close(results)
					return
				}
			}
		}
	}()

	return results, errs
}

func validateEnvelope(envelope Envelope, seen map[string]struct{}) error {
	if envelope.RunID == "" || envelope.ObligationID == "" {
		return errors.New("invalid execution identity")
	}
	if envelope.ExecutionGeneration <= 0 {
		return errors.New("invalid execution generation")
	}
	if envelope.ExecutionAuthorityCommit == "" || envelope.ClaimedRevision == "" {
		return errors.New("incomplete execution authority")
	}
	if envelope.ExecutionCapability == "" || envelope.ExecutionCapabilitySHA256 == "" {
		return errors.New("missing execution capability")
	}
	if envelope.ExecutionSpecSHA256 == "" {
		return errors.New("missing execution spec digest")
	}
	if err := validateEnvelopeDigests(envelope); err != nil {
		return err
	}
	key := fmt.Sprintf("%s/%d/%s", envelope.RunID, envelope.ExecutionGeneration, envelope.ExecutionAuthorityCommit)
	if _, exists := seen[key]; exists {
		return fmt.Errorf("duplicate execution identity: %s", key)
	}
	seen[key] = struct{}{}
	return nil
}
