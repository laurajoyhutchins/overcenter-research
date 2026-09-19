package executor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

type executionJob struct {
	key       string
	validated validatedExecution
	ctx       context.Context
	cancel    context.CancelFunc
}

type Runtime struct {
	workspaceRoot  string
	maxConcurrency int
}

func NewRuntime(workspaceRoot string, maxConcurrency int) (*Runtime, error) {
	if maxConcurrency <= 0 {
		return nil, errors.New("max concurrency must be positive")
	}
	root, err := validateWorkspaceRoot(workspaceRoot)
	if err != nil {
		return nil, err
	}
	return &Runtime{
		workspaceRoot:  root,
		maxConcurrency: maxConcurrency,
	}, nil
}

func (runtime *Runtime) Serve(ctx context.Context, input io.Reader, output io.Writer) error {
	runtimeCtx, cancelAll := context.WithCancel(ctx)
	defer cancelAll()

	commands := make(chan ExecutorCommandV1)
	readErr := make(chan error, 1)
	go func() {
		defer close(commands)
		defer close(readErr)

		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 64*1024), 3*1024*1024)
		for scanner.Scan() {
			command, err := parseCommand(scanner.Bytes())
			if err != nil {
				readErr <- err
				return
			}
			select {
			case commands <- command:
			case <-runtimeCtx.Done():
				return
			}
		}
		if err := scanner.Err(); err != nil {
			readErr <- err
		}
	}()

	jobs := make(chan executionJob)
	results := make(chan ComputationAttemptEvidenceV1, runtime.maxConcurrency)
	done := make(chan string, runtime.maxConcurrency)

	var workers sync.WaitGroup
	for worker := 0; worker < runtime.maxConcurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				evidence := runProcess(job.ctx, runtime.workspaceRoot, job.validated)
				job.cancel()
				select {
				case results <- evidence:
				case <-runtimeCtx.Done():
				}
				select {
				case done <- job.key:
				case <-runtimeCtx.Done():
				}
			}
		}()
	}

	writeErr := make(chan error, 1)
	go func() {
		defer close(writeErr)
		encoder := json.NewEncoder(output)
		for result := range results {
			if err := encoder.Encode(result); err != nil {
				writeErr <- err
				cancelAll()
				return
			}
		}
	}()

	seen := map[string]struct{}{}
	running := map[string]context.CancelFunc{}
	inflight := 0
	var serveErr error
	commandsOpen := true
	readErrOpen := true
	writeErrOpen := true

	for commandsOpen && serveErr == nil {
		select {
		case <-runtimeCtx.Done():
			if !errors.Is(runtimeCtx.Err(), context.Canceled) || ctx.Err() != nil {
				serveErr = runtimeCtx.Err()
			}
			commandsOpen = false
		case key := <-done:
			if cancel, exists := running[key]; exists {
				cancel()
				delete(running, key)
				inflight--
			}
		case command, ok := <-commands:
			if !ok {
				commandsOpen = false
				continue
			}
			switch command.Kind {
			case "execute":
				if command.Execution == nil || command.validated == nil {
					serveErr = errors.New("validated execution missing")
					continue
				}
				key := identityKey(identityFor(*command.Execution))
				if _, duplicate := seen[key]; duplicate {
					serveErr = fmt.Errorf("duplicate execution identity: %s", key)
					continue
				}
				if inflight >= runtime.maxConcurrency {
					serveErr = errors.New("executor capacity exceeded")
					continue
				}
				seen[key] = struct{}{}
				executionCtx, executionCancel := context.WithCancel(runtimeCtx)
				running[key] = executionCancel
				inflight++
				job := executionJob{
					key:       key,
					validated: *command.validated,
					ctx:       executionCtx,
					cancel:    executionCancel,
				}
				select {
				case jobs <- job:
				case <-runtimeCtx.Done():
					serveErr = runtimeCtx.Err()
				}
			case "cancel":
				if command.Identity == nil {
					serveErr = errors.New("cancel identity missing")
					continue
				}
				if cancel, exists := running[identityKey(*command.Identity)]; exists {
					cancel()
				}
			default:
				serveErr = errors.New("unknown executor command")
			}
		case err, ok := <-readErr:
			if !ok {
				readErrOpen = false
				readErr = nil
				continue
			}
			if err != nil {
				serveErr = err
			}
		case err, ok := <-writeErr:
			if !ok {
				writeErrOpen = false
				writeErr = nil
				continue
			}
			if err != nil {
				serveErr = err
			}
		}
	}

	cancelAll()
	for _, cancel := range running {
		cancel()
	}
	close(jobs)
	workers.Wait()
	close(results)

	if writeErrOpen {
		for err := range writeErr {
			if err != nil && serveErr == nil {
				serveErr = err
			}
		}
	}
	if readErrOpen {
		for err := range readErr {
			if err != nil && serveErr == nil {
				serveErr = err
			}
		}
	}

	if serveErr != nil && errors.Is(serveErr, context.Canceled) && ctx.Err() == nil {
		return nil
	}
	return serveErr
}
