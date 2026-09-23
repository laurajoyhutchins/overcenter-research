import type {
  AdapterProtocol,
  MutationReality,
  ProtocolState,
  ProtocolTransition,
} from './adapter-diagnosability.ts';

export interface AdapterDiagnosabilityCase {
  protocol: AdapterProtocol;
  expected: {
    diagnosable: boolean;
    safeDiagnosable: boolean;
    decision: 'safe-to-release' | 'ambiguous-do-not-release';
  };
}

const state = (id: string, mutation: MutationReality): ProtocolState => ({ id, mutation });
const transition = (
  from: string,
  to: string,
  event: string,
  observation?: string,
  consequential?: string,
): ProtocolTransition => ({
  from,
  to,
  event,
  ...(observation === undefined ? {} : { observation }),
  ...(consequential === undefined ? {} : { consequential }),
});

export const ADAPTER_DIAGNOSABILITY_CASES = [
  {
    protocol: {
      id: 'github-status-pre-secure-connect',
      initial: 's',
      states: [state('s', 'not-occurred'), state('n', 'not-occurred'), state('r', 'not-occurred')],
      transitions: [
        transition(
          's',
          'n',
          'fresh-https-fails-before-secureConnect',
          'GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED',
        ),
        transition('n', 'r', 'release-reservation', 'RELEASED', 'release-authority'),
        transition('r', 'r', 'idle', 'IDLE'),
      ],
    },
    expected: {
      diagnosable: true,
      safeDiagnosable: true,
      decision: 'safe-to-release',
    },
  },
  {
    protocol: {
      id: 'github-status-post-secure-connect-reset',
      initial: 's',
      states: [
        state('s', 'not-occurred'),
        state('c', 'occurred'),
        state('n', 'not-occurred'),
        state('ma', 'occurred'),
        state('na', 'not-occurred'),
        state('mr', 'occurred'),
        state('nr', 'not-occurred'),
      ],
      transitions: [
        transition('s', 'c', 'remote-commit'),
        transition('s', 'n', 'remote-no-commit'),
        transition(
          'c',
          'ma',
          'post-secureConnect-reset',
          'GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN',
        ),
        transition(
          'n',
          'na',
          'post-secureConnect-reset',
          'GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN',
        ),
        transition('ma', 'mr', 'release-reservation', 'RELEASED', 'release-authority'),
        transition('na', 'nr', 'release-reservation', 'RELEASED', 'release-authority'),
        transition('mr', 'mr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
        transition('nr', 'nr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
      ],
    },
    expected: {
      diagnosable: false,
      safeDiagnosable: false,
      decision: 'ambiguous-do-not-release',
    },
  },
  {
    protocol: {
      id: 'github-status-http-502',
      initial: 's',
      states: [
        state('s', 'not-occurred'),
        state('c', 'occurred'),
        state('n', 'not-occurred'),
        state('ma', 'occurred'),
        state('na', 'not-occurred'),
        state('mr', 'occurred'),
        state('nr', 'not-occurred'),
      ],
      transitions: [
        transition('s', 'c', 'remote-commit'),
        transition('s', 'n', 'remote-no-commit'),
        transition('c', 'ma', 'http-response', 'GITHUB_STATUS_MUTATION_FAILED:502'),
        transition('n', 'na', 'http-response', 'GITHUB_STATUS_MUTATION_FAILED:502'),
        transition('ma', 'mr', 'release-reservation', 'RELEASED', 'release-authority'),
        transition('na', 'nr', 'release-reservation', 'RELEASED', 'release-authority'),
        transition('mr', 'mr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
        transition('nr', 'nr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
      ],
    },
    expected: {
      diagnosable: false,
      safeDiagnosable: false,
      decision: 'ambiguous-do-not-release',
    },
  },
] as const satisfies readonly AdapterDiagnosabilityCase[];
