export interface GitCommitWitness {
  sha:string;
  tree_sha:string;
  parents:string[];
}

export interface CandidateCertificationWitness {
  source_sha:string;
  base_sha:string;
  outcome:'success'|'failure'|'active';
}

export interface ContentPreservingMergeWitness {
  merge_sha:string;
  base_sha:string;
  certified_head_sha:string;
  tree_sha:string;
}

function objectId(value:string,name:string):string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`MERGE_EVIDENCE_OBJECT_ID_INVALID:${name}`);
  }
  return value;
}

export function contentPreservingMergeWitness(
  merge:GitCommitWitness,
  certification:CandidateCertificationWitness,
  certifiedHead:GitCommitWitness,
):ContentPreservingMergeWitness|null {
  objectId(merge.sha,'merge.sha');
  objectId(merge.tree_sha,'merge.tree_sha');
  objectId(certification.source_sha,'certification.source_sha');
  objectId(certification.base_sha,'certification.base_sha');
  objectId(certifiedHead.sha,'certified_head.sha');
  objectId(certifiedHead.tree_sha,'certified_head.tree_sha');
  for (const [index,parent] of merge.parents.entries()) {
    objectId(parent,`merge.parents[${index}]`);
  }

  if (certification.outcome!=='success') return null;
  if (certification.source_sha!==certifiedHead.sha) return null;
  if (merge.parents.length!==2) return null;
  if (merge.parents[0]!==certification.base_sha) return null;
  if (merge.parents[1]!==certification.source_sha) return null;
  if (merge.tree_sha!==certifiedHead.tree_sha) return null;

  return {
    merge_sha:merge.sha,
    base_sha:certification.base_sha,
    certified_head_sha:certification.source_sha,
    tree_sha:merge.tree_sha,
  };
}
