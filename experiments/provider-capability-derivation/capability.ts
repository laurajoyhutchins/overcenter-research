import type { Postcondition } from '../../src/model.ts';
import {
  effectEquivalenceWitness,
  effectSemantics,
} from '../../src/semantics.ts';

export interface MutationCapabilityFootprint {
  physical_resource:string;
  semantic_operation:string;
  equivalence_witness_digest:string|null;
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
    equivalence_witness_digest:
      effectEquivalenceWitness(postcondition)?.certificate_digest??null,
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

  if (
    left.equivalence_witness_digest
    && left.equivalence_witness_digest===right.equivalence_witness_digest
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
