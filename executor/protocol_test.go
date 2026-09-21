package executor

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type conformanceCorpus struct {
	Schema string `json:"schema"`
	Cases  []struct {
		Name  string         `json:"name"`
		Valid bool           `json:"valid"`
		Spec  map[string]any `json:"spec"`
	} `json:"cases"`
}

func contractFile(t *testing.T, id, name string) string {
	t.Helper()
	matches, err := filepath.Glob("../contracts/*/contract.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, metadataPath := range matches {
		data, err := os.ReadFile(metadataPath)
		if err != nil {
			t.Fatal(err)
		}
		var metadata struct{ ID string `json:"id"` }
		if err := json.Unmarshal(data, &metadata); err != nil {
			t.Fatal(err)
		}
		if metadata.ID == id {
			return filepath.Join(filepath.Dir(metadataPath), name)
		}
	}
	t.Fatalf("contract package not found: %s", id)
	return ""
}

func TestSharedProcessSpecConformance(t *testing.T) {
	data, err := os.ReadFile(contractFile(t, "computation-execution", "process-spec-conformance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus conformanceCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range corpus.Cases {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			raw, err := json.Marshal(testCase.Spec)
			if err != nil {
				t.Fatal(err)
			}
			_, err = validateProcessSpecBytes(raw)
			if testCase.Valid && err != nil {
				t.Fatalf("valid fixture rejected: %v", err)
			}
			if !testCase.Valid && err == nil {
				t.Fatal("invalid fixture accepted")
			}
		})
	}
}

func TestExecutionBindsExactSpecBytes(t *testing.T) {
	capability := "capability"
	capabilityDigest := sha256.Sum256([]byte(capability))
	spec := []byte(fmt.Sprintf(`{"schema":%q,"executable":"/bin/echo","argv":["hello"],"cwd":".","env":{},"timeout_ms":1000,"stdout_max_bytes":1024,"stderr_max_bytes":1024}`, ProcessSpecSchema))
	specDigest := sha256.Sum256(spec)

	execution := ComputationExecutionV1{
		Schema:                    ComputationExecutionSchema,
		RunID:                     "run",
		ObligationID:              "obligation",
		ClaimedRevision:           "revision",
		ExecutionGeneration:       1,
		ExecutionAuthorityCommit:  "authority",
		ExecutionCapability:       capability,
		ExecutionCapabilitySHA256: hex.EncodeToString(capabilityDigest[:]),
		ExecutionSpecBase64:       base64.StdEncoding.EncodeToString(spec),
		ExecutionSpecSHA256:       "sha256:" + hex.EncodeToString(specDigest[:]),
	}
	raw, err := json.Marshal(execution)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateExecutionBytes(raw); err != nil {
		t.Fatalf("valid execution rejected: %v", err)
	}

	mutated := append([]byte(nil), spec...)
	mutated[len(mutated)-2] = ' '
	execution.ExecutionSpecBase64 = base64.StdEncoding.EncodeToString(mutated)
	raw, err = json.Marshal(execution)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateExecutionBytes(raw); err == nil {
		t.Fatal("mutated exact bytes accepted under old digest")
	}
}

func TestExecutionIdentityKeyDoesNotAliasDelimiterShapedFields(t *testing.T) {
	first := identityKey(ExecutionIdentityV1{
		RunID:                    "a/1",
		ExecutionGeneration:      2,
		ExecutionAuthorityCommit: "c",
	})
	second := identityKey(ExecutionIdentityV1{
		RunID:                    "a",
		ExecutionGeneration:      1,
		ExecutionAuthorityCommit: "2/c",
	})
	if first == second {
		t.Fatal("distinct execution identity tuples aliased")
	}
}

func TestGoExecutionValidationMatchesTrustedIdentityBounds(t *testing.T) {
	capability := "capability"
	capabilityDigest := sha256.Sum256([]byte(capability))
	spec := []byte(fmt.Sprintf(`{"schema":%q,"executable":"/bin/true","argv":[],"cwd":".","env":{},"timeout_ms":1000,"stdout_max_bytes":0,"stderr_max_bytes":0}`, ProcessSpecSchema))
	specDigest := sha256.Sum256(spec)

	base := ComputationExecutionV1{
		Schema:                    ComputationExecutionSchema,
		RunID:                     "run",
		ObligationID:              "obligation",
		ClaimedRevision:           "revision",
		ExecutionGeneration:       1,
		ExecutionAuthorityCommit:  "authority",
		ExecutionCapability:       capability,
		ExecutionCapabilitySHA256: hex.EncodeToString(capabilityDigest[:]),
		ExecutionSpecBase64:       base64.StdEncoding.EncodeToString(spec),
		ExecutionSpecSHA256:       "sha256:" + hex.EncodeToString(specDigest[:]),
	}

	oversizedRunID := base
	oversizedRunID.RunID = strings.Repeat("r", maxRunIDBytes+1)
	raw, err := json.Marshal(oversizedRunID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateExecutionBytes(raw); err == nil {
		t.Fatal("Go accepted run_id outside the trusted TypeScript contract")
	}

	unsafeGeneration := base
	unsafeGeneration.ExecutionGeneration = maxExecutionGeneration + 1
	raw, err = json.Marshal(unsafeGeneration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateExecutionBytes(raw); err == nil {
		t.Fatal("Go accepted execution_generation outside the trusted TypeScript contract")
	}
}

func TestBoundedDigestWriterHashesUncapturedBytes(t *testing.T) {
	writer := newBoundedDigestWriter(4)
	input := []byte("abcdefgh")
	if _, err := writer.Write(input); err != nil {
		t.Fatal(err)
	}
	if got := writer.base64(); got != base64.StdEncoding.EncodeToString([]byte("abcd")) {
		t.Fatalf("capture=%q", got)
	}
	if !writer.truncated() {
		t.Fatal("expected truncation")
	}
	digest := sha256.Sum256(input)
	if got, want := writer.sha256(), "sha256:"+hex.EncodeToString(digest[:]); got != want {
		t.Fatalf("digest=%q want=%q", got, want)
	}
}
