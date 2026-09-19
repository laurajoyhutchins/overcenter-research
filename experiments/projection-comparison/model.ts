export type ProjectStatus=
  | 'READY'
  | 'BLOCKED'
  | 'EXECUTING'
  | 'WAITING'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

export interface ProjectionRun {
  id:string;
  obligation:string;
  semanticKey:string;
  sequence:number;
}

export interface ProjectionReceipt {
  run:string;
  disposition:'DONE'|'READY'|'WAITING'|'RECOVERY_REQUIRED';
  sequence:number;
}

export interface ProjectionInput {
  obligations:string[];
  dependencies:Array<{downstream:string;upstream:string}>;
  semanticKeys:Map<string,string|null>;
  runs:ProjectionRun[];
  receipts:ProjectionReceipt[];
  admissibleRuns:Set<string>;
}

export type StatusMap=Map<string,ProjectStatus>;

export function sortedStatuses(statuses:StatusMap):Array<[string,ProjectStatus]> {
  return [...statuses.entries()].sort(([a],[b])=>a.localeCompare(b));
}
