import Lean.Data.Json.Printer
import Overcenter.KeyPreimage

open Lean

namespace Overcenter

inductive GraphTensorRelation where
  | control
  | semanticVerifiedContent
  | semanticSettlementReceipt
  deriving Repr, BEq, DecidableEq

def graphTensorRelationName : GraphTensorRelation → String
  | .control => "control"
  | .semanticVerifiedContent => "semantic-verified-content"
  | .semanticSettlementReceipt => "semantic-settlement-receipt"

def graphTensorRelationCode : GraphTensorRelation → Nat
  | .control => 0
  | .semanticVerifiedContent => 1
  | .semanticSettlementReceipt => 2

def graphTensorRelationFor : RawClaimDependency → Option GraphTensorRelation
  | { kind := .control, selector := none, .. } => some .control
  | { kind := .semantic, selector := some .verifiedContent, .. } =>
      some .semanticVerifiedContent
  | { kind := .semantic, selector := some .settlementReceipt, .. } =>
      some .semanticSettlementReceipt
  | _ => none

structure GraphViewEdge where
  sourceId : String
  targetId : String
  relation : GraphTensorRelation
  deriving Repr, BEq, DecidableEq

structure GraphView where
  nodeIds : List String
  edges : List GraphViewEdge
  deriving Repr, BEq, DecidableEq

structure GraphTensorEntry where
  sourceIndex : Nat
  targetIndex : Nat
  relation : GraphTensorRelation
  sourceId : String
  targetId : String
  deriving Repr, BEq, DecidableEq

structure GraphTensorProjection where
  viewKey : String
  nodeIds : List String
  entries : List GraphTensorEntry
  deriving Repr, BEq, DecidableEq

def graphViewEdgeJson (edge : GraphViewEdge) : Json :=
  Json.mkObj [
    ("source", edge.sourceId),
    ("relation", graphTensorRelationName edge.relation),
    ("target", edge.targetId)
  ]

def graphViewEdgeKey (edge : GraphViewEdge) : String :=
  (Json.arr #[
    Json.str edge.sourceId,
    Json.str (graphTensorRelationName edge.relation),
    Json.str edge.targetId
  ]).compress

def insertSortedGraphEdge
    (value : GraphViewEdge) : List GraphViewEdge → List GraphViewEdge
  | [] => [value]
  | head :: tail =>
      if stringLessOrEqual (graphViewEdgeKey value) (graphViewEdgeKey head)
      then value :: head :: tail
      else head :: insertSortedGraphEdge value tail

def sortGraphEdges : List GraphViewEdge → List GraphViewEdge
  | [] => []
  | head :: tail => insertSortedGraphEdge head (sortGraphEdges tail)

def uniqueGraphViewEdges : List GraphViewEdge → Bool
  | [] => true
  | edge :: rest => !rest.contains edge && uniqueGraphViewEdges rest

def graphEdgesUnsorted (ctx : RawClaimContext) : List GraphViewEdge :=
  ctx.obligations.flatMap (fun obligation =>
    obligation.dependencies.filterMap (fun dependency => do
      let relation ← graphTensorRelationFor dependency
      pure {
        sourceId := obligation.id
        targetId := dependency.upstream
        relation
      }))

def graphView (ctx : RawClaimContext) : GraphView := {
  nodeIds := sortStrings (rawObligationIds ctx)
  edges := sortGraphEdges (graphEdgesUnsorted ctx)
}

def graphViewKey (view : GraphView) : String :=
  (Json.mkObj [
    ("schema", "overcenter-lean-graph-view/v1"),
    ("node_ids", Json.arr (view.nodeIds.map Json.str).toArray),
    ("edges", Json.arr (view.edges.map graphViewEdgeJson).toArray)
  ]).compress

private def nodeIndexAux
    (needle : String) : List String → Nat → Option Nat
  | [], _ => none
  | head :: tail, index =>
      if head == needle then
        some index
      else
        nodeIndexAux needle tail (index + 1)

def nodeIndex? (nodeIds : List String) (needle : String) : Option Nat :=
  nodeIndexAux needle nodeIds 0

def tensorEntryFor
    (nodeIds : List String)
    (edge : GraphViewEdge) : Option GraphTensorEntry := do
  let sourceIndex ← nodeIndex? nodeIds edge.sourceId
  let targetIndex ← nodeIndex? nodeIds edge.targetId
  pure {
    sourceIndex
    targetIndex
    relation := edge.relation
    sourceId := edge.sourceId
    targetId := edge.targetId
  }

def tensorEntryAligned
    (projection : GraphTensorProjection)
    (entry : GraphTensorEntry) : Bool :=
  projection.nodeIds.get? entry.sourceIndex == some entry.sourceId &&
  projection.nodeIds.get? entry.targetIndex == some entry.targetId

def tensorAligned (projection : GraphTensorProjection) : Bool :=
  projection.entries.all (tensorEntryAligned projection)

def tensorWitnessEdges (projection : GraphTensorProjection) : List GraphViewEdge :=
  projection.entries.map (fun entry => {
    sourceId := entry.sourceId
    targetId := entry.targetId
    relation := entry.relation
  })

def finalizeGraphTensor
    (projection : GraphTensorProjection) : Option GraphTensorProjection :=
  if tensorAligned projection then some projection else none

def buildGraphTensor (ctx : RawClaimContext) : Option GraphTensorProjection :=
  if !rawContextBasicWellFormed ctx then
    none
  else
    let view := graphView ctx
    if !uniqueGraphViewEdges view.edges then
      none
    else
      match view.edges.mapM (tensorEntryFor view.nodeIds) with
      | none => none
      | some entries =>
          finalizeGraphTensor {
            viewKey := graphViewKey view
            nodeIds := view.nodeIds
            entries
          }

def hasGraphViewEdge
    (view : GraphView)
    (sourceId targetId : String)
    (relation : GraphTensorRelation) : Bool :=
  view.edges.any (fun edge =>
    edge.sourceId == sourceId &&
    edge.targetId == targetId &&
    edge.relation == relation)

def hasTypedTwoHop
    (view : GraphView)
    (sourceId targetId : String)
    (leftRelation rightRelation : GraphTensorRelation) : Bool :=
  view.nodeIds.any (fun middleId =>
    hasGraphViewEdge view sourceId middleId leftRelation &&
    hasGraphViewEdge view middleId targetId rightRelation)

def verifyTypedTwoHop
    (ctx : RawClaimContext)
    (viewKey sourceId targetId : String)
    (leftRelation rightRelation : GraphTensorRelation) : Bool :=
  match buildGraphTensor ctx with
  | none => false
  | some projection =>
      projection.viewKey == viewKey &&
      hasTypedTwoHop (graphView ctx)
        sourceId targetId leftRelation rightRelation

end Overcenter
