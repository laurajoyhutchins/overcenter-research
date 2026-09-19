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

type Server struct {
	workspaceRoot  string
	maxConcurrency int

	mu     sync.Mutex
	active map[string]context.CancelFunc
	seen   map[string]struct{}
	wg     sync.WaitGroup

	outputMu sync.Mutex
	output   io.Writer
}

func NewServer(workspaceRoot string, maxConcurrency int, output io.Writer) (*Server, error) {
	root, err := validateWorkspaceRoot(workspaceRoot)
	if err != nil {
		return nil, err
	}
	if maxConcurrency <= 0 {
		return nil, errors.New("max concurrency must be positive")
	}
	if output == nil {
		return nil, errors.New("output is required")
	}
	return &Server{
		workspaceRoot:  root,
		maxConcurrency: maxConcurrency,
		active:         map[string]context.CancelFunc{},
		seen:           map[string]struct{}{},
		output:         output,
	}, nil
}

func (server *Server) Serve(ctx context.Context, input io.Reader) error {
	if input == nil {
		return errors.New("input is required")
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			server.cancelAll()
			server.wg.Wait()
			return err
		}
		command, err := parseCommand(scanner.Bytes())
		if err != nil {
			server.cancelAll()
			server.wg.Wait()
			return err
		}
		switch command.Kind {
		case "execute":
			if err := server.start(ctx, command); err != nil {
				server.cancelAll()
				server.wg.Wait()
				return err
			}
		case "cancel":
			server.cancel(*command.Identity)
		default:
			server.cancelAll()
			server.wg.Wait()
			return fmt.Errorf("unsupported command kind: %s", command.Kind)
		}
	}

	if err := scanner.Err(); err != nil {
		server.cancelAll()
		server.wg.Wait()
		return err
	}

	// Transport EOF means the trusted client is gone. There is nowhere valid to
	// return evidence, so no accepted computation may continue as an orphan.
	server.cancelAll()
	server.wg.Wait()
	return nil
}

func (server *Server) start(parent context.Context, command ExecutorCommandV1) error {
	if command.Execution == nil || command.validated == nil {
		return errors.New("validated execution is required")
	}
	identity := identityFor(*command.Execution)
	key := identityKey(identity)

	server.mu.Lock()
	if _, duplicate := server.seen[key]; duplicate {
		server.mu.Unlock()
		return fmt.Errorf("duplicate execution identity: %s", key)
	}
	if len(server.active) >= server.maxConcurrency {
		server.mu.Unlock()
		return errors.New("executor at capacity")
	}
	runCtx, cancel := context.WithCancel(parent)
	server.seen[key] = struct{}{}
	server.active[key] = cancel
	server.wg.Add(1)
	validated := *command.validated
	server.mu.Unlock()

	go func() {
		defer server.wg.Done()
		evidence := runProcess(runCtx, server.workspaceRoot, validated)

		server.mu.Lock()
		delete(server.active, key)
		server.mu.Unlock()

		// A broken evidence transport makes the whole executor untrustworthy for
		// further work. Serve cannot recover this write error asynchronously, so
		// the process-level client treats malformed/missing evidence plus exit as
		// executor failure. Each record is still emitted atomically.
		_ = server.writeEvidence(evidence)
	}()
	return nil
}

func (server *Server) cancel(identity ExecutionIdentityV1) {
	key := identityKey(identity)
	server.mu.Lock()
	cancel := server.active[key]
	server.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (server *Server) cancelAll() {
	server.mu.Lock()
	cancellations := make([]context.CancelFunc, 0, len(server.active))
	for _, cancel := range server.active {
		cancellations = append(cancellations, cancel)
	}
	server.mu.Unlock()
	for _, cancel := range cancellations {
		cancel()
	}
}

func (server *Server) writeEvidence(evidence ComputationAttemptEvidenceV1) error {
	payload, err := json.Marshal(evidence)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	server.outputMu.Lock()
	defer server.outputMu.Unlock()
	_, err = server.output.Write(payload)
	return err
}
