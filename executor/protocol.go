package executor

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	maxSpecBytes      = 1024 * 1024
	maxArgCount       = 256
	maxArgBytes       = 32 * 1024
	maxEnvCount       = 256
	maxEnvValueBytes  = 128 * 1024
	maxTimeoutMillis       = 24 * 60 * 60 * 1000
	maxCaptureBytes        = 16 * 1024 * 1024
	maxRunIDBytes          = 256
	maxObligationIDBytes   = 512
	maxRevisionBytes       = 256
	maxAuthorityCommitBytes = 256
	maxCapabilityBytes     = 4096
	maxExecutionGeneration = 9007199254740991
)

var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type ProcessSpecV1 struct {
	Schema         string            `json:"schema"`
	Executable     string            `json:"executable"`
	Argv           []string          `json:"argv"`
	Cwd            string            `json:"cwd"`
	Env            map[string]string `json:"env"`
	TimeoutMillis  int64             `json:"timeout_ms"`
	StdoutMaxBytes int64             `json:"stdout_max_bytes"`
	StderrMaxBytes int64             `json:"stderr_max_bytes"`
}

type ComputationExecutionV1 struct {
	Schema                    string `json:"schema"`
	RunID                     string `json:"run_id"`
	ObligationID              string `json:"obligation_id"`
	ClaimedRevision           string `json:"claimed_revision"`
	ExecutionGeneration       int64  `json:"execution_generation"`
	ExecutionAuthorityCommit  string `json:"execution_authority_commit"`
	ExecutionCapability       string `json:"execution_capability"`
	ExecutionCapabilitySHA256 string `json:"execution_capability_sha256"`
	ExecutionSpecBase64       string `json:"execution_spec_base64"`
	ExecutionSpecSHA256       string `json:"execution_spec_sha256"`
}

type ExecutionIdentityV1 struct {
	RunID                    string `json:"run_id"`
	ExecutionGeneration      int64  `json:"execution_generation"`
	ExecutionAuthorityCommit string `json:"execution_authority_commit"`
}

type ExecutorCommandV1 struct {
	Schema    string
	Kind      string
	Execution *ComputationExecutionV1
	Identity  *ExecutionIdentityV1
	validated *validatedExecution
}

type ComputationAttemptEvidenceV1 struct {
	Schema                    string `json:"schema"`
	RunID                     string `json:"run_id"`
	ObligationID              string `json:"obligation_id"`
	ClaimedRevision           string `json:"claimed_revision"`
	ExecutionGeneration       int64  `json:"execution_generation"`
	ExecutionAuthorityCommit  string `json:"execution_authority_commit"`
	ExecutionCapabilitySHA256 string `json:"execution_capability_sha256"`
	ExecutionSpecSHA256       string `json:"execution_spec_sha256"`
	Outcome                   string `json:"outcome"`
	ExitCode                  *int   `json:"exit_code,omitempty"`
	Signal                    string `json:"signal,omitempty"`
	StdoutBase64              string `json:"stdout_base64,omitempty"`
	StdoutSHA256              string `json:"stdout_sha256"`
	StdoutTruncated           bool   `json:"stdout_truncated"`
	StderrBase64              string `json:"stderr_base64,omitempty"`
	StderrSHA256              string `json:"stderr_sha256"`
	StderrTruncated           bool   `json:"stderr_truncated"`
	Error                     string `json:"error,omitempty"`
}

type validatedExecution struct {
	Execution ComputationExecutionV1
	Spec      ProcessSpecV1
	SpecBytes []byte
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateExactObjectKeys(
	data []byte,
	required []string,
	optional []string,
	name string,
) error {
	var object map[string]json.RawMessage
	if err := decodeStrict(data, &object); err != nil {
		return fmt.Errorf("invalid %s: %w", name, err)
	}
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range object {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("%s unknown field: %s", name, key)
		}
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return fmt.Errorf("%s missing field: %s", name, key)
		}
	}
	return nil
}

func validateString(value, name string, maxBytes int) error {
	if value == "" || strings.ContainsRune(value, 0) || len([]byte(value)) > maxBytes {
		return fmt.Errorf("%s invalid", name)
	}
	return nil
}

func validateIdentity(identity ExecutionIdentityV1) error {
	if err := validateString(identity.RunID, "run_id", maxRunIDBytes); err != nil {
		return err
	}
	if identity.ExecutionGeneration <= 0 || identity.ExecutionGeneration > maxExecutionGeneration {
		return errors.New("execution_generation invalid")
	}
	if err := validateString(identity.ExecutionAuthorityCommit, "execution_authority_commit", maxAuthorityCommitBytes); err != nil {
		return err
	}
	return nil
}

type executionIdentityKey struct {
	RunID                    string
	ExecutionGeneration      int64
	ExecutionAuthorityCommit string
}

func identityKey(identity ExecutionIdentityV1) executionIdentityKey {
	return executionIdentityKey{
		RunID:                    identity.RunID,
		ExecutionGeneration:      identity.ExecutionGeneration,
		ExecutionAuthorityCommit: identity.ExecutionAuthorityCommit,
	}
}

func identityFor(execution ComputationExecutionV1) ExecutionIdentityV1 {
	return ExecutionIdentityV1{
		RunID:                    execution.RunID,
		ExecutionGeneration:      execution.ExecutionGeneration,
		ExecutionAuthorityCommit: execution.ExecutionAuthorityCommit,
	}
}

func parseCommand(line []byte) (ExecutorCommandV1, error) {
	if err := validateExactObjectKeys(
		line,
		[]string{"schema", "kind"},
		[]string{"execution", "identity"},
		"executor command",
	); err != nil {
		return ExecutorCommandV1{}, err
	}
	var wire struct {
		Schema    string          `json:"schema"`
		Kind      string          `json:"kind"`
		Execution json.RawMessage `json:"execution,omitempty"`
		Identity  json.RawMessage `json:"identity,omitempty"`
	}
	if err := decodeStrict(line, &wire); err != nil {
		return ExecutorCommandV1{}, fmt.Errorf("invalid executor command: %w", err)
	}
	if wire.Schema != ExecutorCommandSchema {
		return ExecutorCommandV1{}, errors.New("executor command schema mismatch")
	}

	switch wire.Kind {
	case "execute":
		if len(wire.Execution) == 0 || len(wire.Identity) != 0 {
			return ExecutorCommandV1{}, errors.New("execute command shape invalid")
		}
		validated, err := validateExecutionBytes(wire.Execution)
		if err != nil {
			return ExecutorCommandV1{}, err
		}
		return ExecutorCommandV1{
			Schema:    wire.Schema,
			Kind:      wire.Kind,
			Execution: &validated.Execution,
			validated: &validated,
		}, nil
	case "cancel":
		if len(wire.Identity) == 0 || len(wire.Execution) != 0 {
			return ExecutorCommandV1{}, errors.New("cancel command shape invalid")
		}
		if err := validateExactObjectKeys(
			wire.Identity,
			[]string{"run_id", "execution_generation", "execution_authority_commit"},
			nil,
			"cancel identity",
		); err != nil {
			return ExecutorCommandV1{}, err
		}
		var identity ExecutionIdentityV1
		if err := decodeStrict(wire.Identity, &identity); err != nil {
			return ExecutorCommandV1{}, fmt.Errorf("invalid cancel identity: %w", err)
		}
		if err := validateIdentity(identity); err != nil {
			return ExecutorCommandV1{}, err
		}
		return ExecutorCommandV1{
			Schema:   wire.Schema,
			Kind:     wire.Kind,
			Identity: &identity,
		}, nil
	default:
		return ExecutorCommandV1{}, errors.New("executor command kind invalid")
	}
}

func validateExecutionBytes(data []byte) (validatedExecution, error) {
	if err := validateExactObjectKeys(
		data,
		[]string{
			"schema",
			"run_id",
			"obligation_id",
			"claimed_revision",
			"execution_generation",
			"execution_authority_commit",
			"execution_capability",
			"execution_capability_sha256",
			"execution_spec_base64",
			"execution_spec_sha256",
		},
		nil,
		"computation execution",
	); err != nil {
		return validatedExecution{}, err
	}
	var execution ComputationExecutionV1
	if err := decodeStrict(data, &execution); err != nil {
		return validatedExecution{}, fmt.Errorf("invalid computation execution: %w", err)
	}
	if execution.Schema != ComputationExecutionSchema {
		return validatedExecution{}, errors.New("computation execution schema mismatch")
	}
	for _, field := range []struct {
		name     string
		value    string
		maxBytes int
	}{
		{name: "run_id", value: execution.RunID, maxBytes: maxRunIDBytes},
		{name: "obligation_id", value: execution.ObligationID, maxBytes: maxObligationIDBytes},
		{name: "claimed_revision", value: execution.ClaimedRevision, maxBytes: maxRevisionBytes},
		{name: "execution_authority_commit", value: execution.ExecutionAuthorityCommit, maxBytes: maxAuthorityCommitBytes},
	} {
		if err := validateString(field.value, field.name, field.maxBytes); err != nil {
			return validatedExecution{}, err
		}
	}
	if execution.ExecutionGeneration <= 0 || execution.ExecutionGeneration > maxExecutionGeneration {
		return validatedExecution{}, errors.New("execution_generation invalid")
	}
	if err := validateString(execution.ExecutionCapability, "execution_capability", maxCapabilityBytes); err != nil {
		return validatedExecution{}, err
	}
	if len(execution.ExecutionCapabilitySHA256) != 64 {
		return validatedExecution{}, errors.New("execution_capability_sha256 invalid")
	}
	capabilityDigest := sha256.Sum256([]byte(execution.ExecutionCapability))
	if hex.EncodeToString(capabilityDigest[:]) != execution.ExecutionCapabilitySHA256 {
		return validatedExecution{}, errors.New("execution capability digest mismatch")
	}

	specBytes, err := base64.StdEncoding.DecodeString(execution.ExecutionSpecBase64)
	if err != nil || len(specBytes) == 0 || len(specBytes) > maxSpecBytes {
		return validatedExecution{}, errors.New("execution_spec_base64 invalid")
	}
	if base64.StdEncoding.EncodeToString(specBytes) != execution.ExecutionSpecBase64 {
		return validatedExecution{}, errors.New("execution_spec_base64 non-canonical")
	}
	specDigest := sha256.Sum256(specBytes)
	if execution.ExecutionSpecSHA256 != "sha256:"+hex.EncodeToString(specDigest[:]) {
		return validatedExecution{}, errors.New("execution spec digest mismatch")
	}

	spec, err := validateProcessSpecBytes(specBytes)
	if err != nil {
		return validatedExecution{}, err
	}
	return validatedExecution{
		Execution: execution,
		Spec:      spec,
		SpecBytes: specBytes,
	}, nil
}

func validateProcessSpecBytes(data []byte) (ProcessSpecV1, error) {
	if err := validateExactObjectKeys(
		data,
		[]string{
			"schema",
			"executable",
			"argv",
			"cwd",
			"env",
			"timeout_ms",
			"stdout_max_bytes",
			"stderr_max_bytes",
		},
		nil,
		"process spec",
	); err != nil {
		return ProcessSpecV1{}, err
	}
	var spec ProcessSpecV1
	if err := decodeStrict(data, &spec); err != nil {
		return ProcessSpecV1{}, fmt.Errorf("invalid process spec: %w", err)
	}
	if spec.Schema != ProcessSpecSchema {
		return ProcessSpecV1{}, errors.New("process spec schema mismatch")
	}
	if err := validateString(spec.Executable, "executable", 4096); err != nil {
		return ProcessSpecV1{}, err
	}
	if !filepath.IsAbs(spec.Executable) {
		return ProcessSpecV1{}, errors.New("executable must be absolute")
	}
	if len(spec.Argv) > maxArgCount {
		return ProcessSpecV1{}, errors.New("argv invalid")
	}
	for index, arg := range spec.Argv {
		if strings.ContainsRune(arg, 0) || len([]byte(arg)) > maxArgBytes {
			return ProcessSpecV1{}, fmt.Errorf("argv invalid at index %d", index)
		}
	}
	if err := validateString(spec.Cwd, "cwd", 4096); err != nil {
		return ProcessSpecV1{}, err
	}
	if filepath.IsAbs(spec.Cwd) {
		return ProcessSpecV1{}, errors.New("cwd must be relative")
	}
	clean := filepath.Clean(spec.Cwd)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return ProcessSpecV1{}, errors.New("cwd escapes workspace")
	}
	spec.Cwd = clean
	if len(spec.Env) > maxEnvCount {
		return ProcessSpecV1{}, errors.New("env too large")
	}
	for key, value := range spec.Env {
		if !envKeyPattern.MatchString(key) {
			return ProcessSpecV1{}, fmt.Errorf("env key invalid: %s", key)
		}
		if strings.ContainsRune(value, 0) || len([]byte(value)) > maxEnvValueBytes {
			return ProcessSpecV1{}, fmt.Errorf("env value invalid: %s", key)
		}
	}
	if spec.TimeoutMillis < 1 || spec.TimeoutMillis > maxTimeoutMillis {
		return ProcessSpecV1{}, errors.New("timeout_ms invalid")
	}
	if spec.StdoutMaxBytes < 0 || spec.StdoutMaxBytes > maxCaptureBytes {
		return ProcessSpecV1{}, errors.New("stdout_max_bytes invalid")
	}
	if spec.StderrMaxBytes < 0 || spec.StderrMaxBytes > maxCaptureBytes {
		return ProcessSpecV1{}, errors.New("stderr_max_bytes invalid")
	}
	return spec, nil
}
