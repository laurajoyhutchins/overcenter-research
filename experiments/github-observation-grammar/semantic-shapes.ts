export interface EntityIdentity {
  repository_id: number;
  node_id: string;
}

export interface RefCollectionPageShape<Member, Evidence> {
  kind: 'collection-page';
  subject: {
    repository_id: number;
    ref: string;
  };
  members: Member[];
  page: number;
  per_page: number;
  has_next: boolean;
  enumeration: 'partial' | 'terminal-page-seen';
  negative_evidence_authoritative: false;
  evidence: Evidence;
}

export interface ShapeEvaluation<T> {
  state: 'SATISFIED' | 'UNSATISFIED' | 'INDETERMINATE';
  reason: string;
  fact?: T;
}

export function sameEntityIdentity(
  left: EntityIdentity,
  right: EntityIdentity,
): boolean {
  return left.repository_id === right.repository_id
    && left.node_id === right.node_id;
}

export function evaluateMutableEntity<TFact, TObligation>({
  fact,
  obligation,
  coordinateMatches,
  differs,
}: {
  fact: TFact;
  obligation: TObligation;
  coordinateMatches: (fact: TFact, obligation: TObligation) => boolean;
  differs: (fact: TFact, obligation: TObligation) => boolean;
}): ShapeEvaluation<TFact> {
  if (!coordinateMatches(fact, obligation)) {
    return { state: 'INDETERMINATE', reason: 'OBSERVATION_COORDINATE_MISMATCH', fact };
  }
  return differs(fact, obligation)
    ? { state: 'UNSATISFIED', reason: 'AUTHORITATIVE_ENTITY_SNAPSHOT_DIFFERS', fact }
    : { state: 'SATISFIED', reason: 'AUTHORITATIVE_ENTITY_SNAPSHOT_MATCHES', fact };
}

export function evaluatePositiveCollectionMember<
  TFact extends RefCollectionPageShape<TMember, unknown>,
  TMember,
  TObligation,
>({
  fact,
  obligation,
  coordinateMatches,
  memberMatches,
  memberDiffers,
}: {
  fact: TFact;
  obligation: TObligation;
  coordinateMatches: (fact: TFact, obligation: TObligation) => boolean;
  memberMatches: (member: TMember, obligation: TObligation) => boolean;
  memberDiffers: (member: TMember, obligation: TObligation) => boolean;
}): ShapeEvaluation<TFact> {
  if (!coordinateMatches(fact, obligation)) {
    return { state: 'INDETERMINATE', reason: 'OBSERVATION_COORDINATE_MISMATCH', fact };
  }
  const member = fact.members.find(candidate => memberMatches(candidate, obligation));
  if (!member) {
    return { state: 'INDETERMINATE', reason: 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE', fact };
  }
  return memberDiffers(member, obligation)
    ? { state: 'UNSATISFIED', reason: 'AUTHORITATIVE_COLLECTION_MEMBER_DIFFERS', fact }
    : { state: 'SATISFIED', reason: 'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES', fact };
}

export function paginationShape(
  page: number,
  perPage: number,
  link: string | null,
): {
  page: number;
  per_page: number;
  has_next: boolean;
  enumeration: 'partial' | 'terminal-page-seen';
  negative_evidence_authoritative: false;
} | null {
  if (!Number.isSafeInteger(page) || page < 1) return null;
  if (!Number.isSafeInteger(perPage) || perPage < 1) return null;
  const hasNext = typeof link === 'string'
    && link.split(',').some(part => /;\s*rel="next"\s*$/.test(part.trim()));
  return {
    page,
    per_page: perPage,
    has_next: hasNext,
    enumeration: hasNext ? 'partial' : 'terminal-page-seen',
    negative_evidence_authoritative: false,
  };
}
