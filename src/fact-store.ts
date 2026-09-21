import type { FactCommit } from './facts.ts';

export interface DurableFactStore {
  head():string|null;
  append(
    expectedHead:string|null,
    message:string,
    files?:Record<string,unknown>,
  ):string|null;
  history(head:string):FactCommit[];
}

export function factCommitFromFiles(
  commit:string,
  parent:string|null,
  files:Record<string,unknown>,
):FactCommit {
  return {
    commit,
    parent,
    obligation:files['obligation.json']??null,
    obligations:files['obligations.json']??null,
    claim:files['claim.json']??null,
    execution_authority:files['execution-authority.json']??null,
    effect_reservation:files['effect-reservation.json']??null,
    receipt:files['receipt.json']??null,
  };
}
