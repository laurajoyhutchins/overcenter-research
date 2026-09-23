import type {
  AbsenceEvidenceCertificate,
  Obligation,
  Postcondition,
} from './model.ts';

export const EFFECT_ADAPTER_CAPABILITIES_SCHEMA=
  'overcenter-effect-adapter-capabilities' as const;

export const GITHUB_COMMIT_STATUS_EFFECT=
  'github-commit-status/set-from-postcondition/v1' as const;

export const GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT=
  'github-pull-request/update-branch' as const;

export type DuplicateDeliverySemantics=
  | 'may-duplicate'
  | 'at-most-once'
  | 'semantically-idempotent';

export type ReplayCapability=
  | {
      kind:'forbidden';
      reason:string;
    }
  | {
      kind:'terminal-absence';
      terminal_absence_evidence_kinds:readonly string[];
    };

export interface EffectAdapterCapabilities {
  schema:typeof EFFECT_ADAPTER_CAPABILITIES_SCHEMA;
  effect_contract:string;
  postcondition_verifier:Postcondition['verifier'];
  duplicate_delivery:DuplicateDeliverySemantics;
  replay:ReplayCapability;
}

export function validateEffectAdapterCapabilities(
  capabilities:EffectAdapterCapabilities,
):void {
  if (capabilities.schema!==EFFECT_ADAPTER_CAPABILITIES_SCHEMA) {
    throw new Error('EFFECT_ADAPTER_CAPABILITIES_SCHEMA_INVALID');
  }
  if (!capabilities.effect_contract) {
    throw new Error('EFFECT_ADAPTER_CONTRACT_INVALID');
  }
  if (capabilities.replay.kind==='forbidden') {
    if (!capabilities.replay.reason) {
      throw new Error('FORBIDDEN_REPLAY_REQUIRES_REASON');
    }
    return;
  }
  if (capabilities.replay.terminal_absence_evidence_kinds.length===0) {
    throw new Error('REPLAY_CAPABILITY_REQUIRES_TERMINAL_EVIDENCE');
  }
  if (capabilities.duplicate_delivery==='may-duplicate') {
    throw new Error('REPLAY_CAPABILITY_REQUIRES_DUPLICATE_EFFECT_PROTECTION');
  }
}

export const EFFECT_ADAPTER_CAPABILITIES:readonly EffectAdapterCapabilities[]=[
  {
    schema:EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
    effect_contract:GITHUB_COMMIT_STATUS_EFFECT,
    postcondition_verifier:'github-commit-status/v2',
    duplicate_delivery:'may-duplicate',
    replay:{
      kind:'forbidden',
      reason:'provider request finality and duplicate-effect suppression are not established',
    },
  },
  {
    schema:EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
    effect_contract:GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
    postcondition_verifier:'github-pull-request-branch-updated/v1',
    duplicate_delivery:'may-duplicate',
    replay:{
      kind:'forbidden',
      reason:'provider request finality and duplicate-effect suppression are not established',
    },
  },
];

for (const capabilities of EFFECT_ADAPTER_CAPABILITIES) {
  validateEffectAdapterCapabilities(capabilities);
}

const byContract=new Map(
  EFFECT_ADAPTER_CAPABILITIES.map(capabilities=>[
    capabilities.effect_contract,
    capabilities,
  ]),
);

export function effectAdapterCapabilities(
  effectContract:unknown,
):EffectAdapterCapabilities|null {
  return typeof effectContract==='string'
    ? byContract.get(effectContract)??null
    : null;
}

export function reservedEffectReplaySafe(
  work:Obligation,
  absenceEvidence:AbsenceEvidenceCertificate,
):boolean {
  const capabilities=effectAdapterCapabilities(work.packet.effect_contract);
  if (!capabilities) return false;
  if (capabilities.postcondition_verifier!==work.postcondition.verifier) {
    return false;
  }
  if (capabilities.replay.kind!=='terminal-absence') return false;
  return capabilities.replay.terminal_absence_evidence_kinds.includes(
    absenceEvidence.kind,
  );
}
