import type {Observation} from '../../src/model.ts';
import {type CandidateObservation} from './candidate.ts';

declare const existing:Observation;
const candidateFromExisting:CandidateObservation=existing;

declare const candidate:CandidateObservation;
const existingFromCandidate:Observation=candidate;

const valid:CandidateObservation={
  verifier:'github-commit-status/v2',
  mutation_certainty:'present',
  provider:'github',
  repository_id:1,
};

// @ts-expect-error verifier vocabulary must remain narrow.
const invalidVerifier:CandidateObservation={
  verifier:'github-commit-status/v1',
  mutation_certainty:'present',
};

// @ts-expect-error provider vocabulary must remain narrow.
const invalidProvider:CandidateObservation={
  verifier:'github-commit-status/v2',
  mutation_certainty:'present',
  provider:'gitlab',
};

// @ts-expect-error closed object vocabulary must reject unknown fields.
const invalidExtra:CandidateObservation={
  verifier:'file-content-equals/v1',
  mutation_certainty:'present',
  observer_generation:1,
};

void [
  candidateFromExisting,
  existingFromCandidate,
  valid,
  invalidVerifier,
  invalidProvider,
  invalidExtra,
];
