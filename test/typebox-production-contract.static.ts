import type {Observation} from '../src/model.ts';

const valid:Observation={
  verifier:'github-commit-status/v2',
  mutation_certainty:'present',
  provider:'github',
  repository_id:1,
};

const invalidVerifier:Observation={
  // @ts-expect-error stale verifier vocabulary must remain rejected.
  verifier:'github-commit-status/v1',
  mutation_certainty:'present',
};

const invalidProvider:Observation={
  verifier:'github-commit-status/v2',
  mutation_certainty:'present',
  // @ts-expect-error provider vocabulary must remain narrow.
  provider:'gitlab',
};

const invalidExtra:Observation={
  verifier:'file-content-equals/v1',
  mutation_certainty:'present',
  // @ts-expect-error closed observation vocabulary must reject unknown fields.
  observer_generation:1,
};

void [valid,invalidVerifier,invalidProvider,invalidExtra];
