import type {
  EffectAuthority,
  Postcondition,
} from './model.ts';

export const GITHUB_COMMIT_STATUS_EFFECT_CONTRACT=
  'github-commit-status/set-from-postcondition/v1' as const;

export function validateEffectAuthority(
  authority:EffectAuthority|undefined,
  postcondition:Postcondition,
):void {
  if (!authority) return;

  if (authority.contract===GITHUB_COMMIT_STATUS_EFFECT_CONTRACT) {
    if (!/^[0-9a-f]{64}$/.test(authority.adapter_contract_digest)) {
      throw new Error('INVALID_EFFECT_ADAPTER_CONTRACT_DIGEST');
    }
    if (
      postcondition.verifier!=='github-commit-status/v1'
      && postcondition.verifier!=='github-commit-status/v2'
    ) {
      throw new Error('EFFECT_AUTHORITY_POSTCONDITION_MISMATCH');
    }
    return;
  }

  const exhaustive:never=authority;
  throw new Error(`UNSUPPORTED_EFFECT_AUTHORITY:${String(exhaustive)}`);
}
