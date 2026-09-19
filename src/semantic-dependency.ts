import type { Dependency } from './model.ts';

export type SemanticDependency=Extract<Dependency,{kind:'semantic'}>;

export type SemanticDependencySelection=
  | {
      kind:'verified-content';
      edge:SemanticDependency & {
        consumes:{kind:'output';selector:'verified-content'};
      };
    }
  | {
      kind:'settlement-receipt';
      edge:SemanticDependency & {
        consumes:{kind:'evidence';selector:'settlement-receipt'};
      };
    };

export function semanticDependencySelection(
  edge:SemanticDependency,
):SemanticDependencySelection {
  if (
    edge.consumes.kind==='output'
    && edge.consumes.selector==='verified-content'
  ) {
    return {
      kind:'verified-content',
      edge:edge as SemanticDependencySelection['edge'],
    };
  }
  if (
    edge.consumes.kind==='evidence'
    && edge.consumes.selector==='settlement-receipt'
  ) {
    return {
      kind:'settlement-receipt',
      edge:edge as SemanticDependencySelection['edge'],
    };
  }
  throw new Error(
    `UNSUPPORTED_SEMANTIC_SELECTOR:${edge.consumes.kind}:${edge.consumes.selector}`,
  );
}
