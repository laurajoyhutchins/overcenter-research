import type { Postcondition } from '../../src/model.ts';
import { effectSemantics } from '../../src/semantics.ts';

export interface MutationCapabilityFootprint {
  /**
   * Canonical provider coordinate whose state may be mutated.
   *
   * For GitHub commit statuses this is derived by the production semantics
   * adapter from repository identity + exact commit + normalized context.
   */
  physical_resource:string;

  /**
   * Provider-semantic operation requested at the coordinate.
   *
   * For GitHub commit statuses this is the desired status state.
   */
  semantic_operation:string;

  /**
   * Current adapter claim: repeating the same semantic operation on this
   * resource is equivalent for Overcenter's settlement semantics.
   *
   * This is not a claim that the provider's complete mutation history is
   * identical. It mirrors EffectSemantics.sameDesiredCommutes exactly.
   */
  same_operation_equivalent_under_adapter:boolean;
}

export type CapabilityRelation =
  | {
      kind:'parallel-disjoint';
      left:MutationCapabilityFootprint;
      right:MutationCapabilityFootprint;
    }
  | {
      kind:'parallel-adapter-commutative';
      resource:string;
      operation:string;
      left:MutationCapabilityFootprint;
      right:MutationCapabilityFootprint;
    }
  | {
      kind:'ordered-conflict';
      resource:string;
      left_operation:string;
      right_operation:string;
      left:MutationCapabilityFootprint;
      right:MutationCapabilityFootprint;
    }
  | {
      kind:'unknown';
      left:MutationCapabilityFootprint|null;
      right:MutationCapabilityFootprint|null;
    };

export function deriveMutationCapabilityFootprint(
  postcondition:Postcondition,
):MutationCapabilityFootprint|null {
  const semantics=effectSemantics(postcondition);
  if (!semantics) return null;
  return {
    physical_resource:semantics.resource,
    semantic_operation:semantics.desired,
    same_operation_equivalent_under_adapter:semantics.sameDesiredCommutes,
  };
}

export function classifyCapabilityRelation(
  left:MutationCapabilityFootprint|null,
  right:MutationCapabilityFootprint|null,
):CapabilityRelation {
  if (!left || !right) {
    return {kind:'unknown',left,right};
  }

  if (left.physical_resource!==right.physical_resource) {
    return {kind:'parallel-disjoint',left,right};
  }

  const sameOperation=left.semantic_operation===right.semantic_operation;
  if (
    sameOperation
    && left.same_operation_equivalent_under_adapter
    && right.same_operation_equivalent_under_adapter
  ) {
    return {
      kind:'parallel-adapter-commutative',
      resource:left.physical_resource,
      operation:left.semantic_operation,
      left,
      right,
    };
  }

  return {
    kind:'ordered-conflict',
    resource:left.physical_resource,
    left_operation:left.semantic_operation,
    right_operation:right.semantic_operation,
    left,
    right,
  };
}

export function deriveCapabilityRelation(
  left:Postcondition,
  right:Postcondition,
):CapabilityRelation {
  return classifyCapabilityRelation(
    deriveMutationCapabilityFootprint(left),
    deriveMutationCapabilityFootprint(right),
  );
}
