import type { Dependency } from '../model.ts';

export type SemanticDependency=Extract<Dependency,{kind:'semantic'}>;

export type SemanticDependencySelection=
  | 'verified-content'
  | 'settlement-receipt';

export function semanticDependencySelection(
  edge:SemanticDependency,
):SemanticDependencySelection {
  if (
    edge.consumes.kind==='output'
    && edge.consumes.selector==='verified-content'
  ) {
    return 'verified-content';
  }
  if (
    edge.consumes.kind==='evidence'
    && edge.consumes.selector==='settlement-receipt'
  ) {
    return 'settlement-receipt';
  }
  throw new Error(
    `UNSUPPORTED_SEMANTIC_SELECTOR:${edge.consumes.kind}:${edge.consumes.selector}`,
  );
}
