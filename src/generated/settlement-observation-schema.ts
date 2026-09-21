// Generated from contracts/observation-evidence-v1/settlement-observation.typebox.ts.
// Do not edit by hand.
export const SettlementObservationSchema={
  "type": "object",
  "additionalProperties": false,
  "required": [
    "verifier",
    "mutation_certainty"
  ],
  "properties": {
    "verifier": {
      "enum": [
        "file-content-equals/v1",
        "eventually-consistent-file-content-equals/v1",
        "github-commit-status/v2",
        "github-pull-request-branch-updated/v1",
        "kubernetes-configmap-exists/v1"
      ]
    },
    "mutation_certainty": {
      "enum": [
        "present",
        "absent",
        "uncertain"
      ]
    },
    "absence_evidence": {
      "$ref": "#/$defs/AbsenceEvidenceEnvelope"
    },
    "path": {
      "type": "string"
    },
    "expected_sha256": {
      "type": "string"
    },
    "actual_sha256": {
      "type": "string"
    },
    "provider": {
      "enum": [
        "github",
        "kubernetes"
      ]
    },
    "authority_id": {
      "type": "string"
    },
    "api_group": {
      "type": "string"
    },
    "resource": {
      "type": "string"
    },
    "namespace": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "observed_uid": {
      "type": "string"
    },
    "observed_resource_version": {
      "type": "string"
    },
    "snapshot_resource_version": {
      "type": "string"
    },
    "repository_id": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "repository_full_name": {
      "type": "string"
    },
    "commit_sha": {
      "type": "string"
    },
    "context": {
      "type": "string"
    },
    "expected_state": {
      "type": "string"
    },
    "actual_state": {
      "type": "string"
    },
    "observation_error": {
      "type": "string"
    },
    "provider_evidence": {
      "type": "object",
      "additionalProperties": true,
      "x-overcenter-providerOwned": true
    },
    "pull_number": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "pull_node_id": {
      "type": "string"
    },
    "expected_previous_head_sha": {
      "type": "string"
    },
    "base_ref": {
      "type": "string"
    },
    "expected_base_sha": {
      "type": "string"
    },
    "actual_head_sha": {
      "type": "string"
    }
  }
} as const;
