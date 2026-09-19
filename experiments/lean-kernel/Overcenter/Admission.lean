import Std.Data.HashSet
import Overcenter.Semantics

namespace Overcenter

inductive ClaimLifecycle where
  | unrealized
  | executing
  | waiting
  | recoveryRequired
  | done
  deriving Repr, BEq, DecidableEq

inductive ClaimDependencyKind where
  | control
  | semantic
  deriving Repr, BEq, DecidableEq

structure ClaimDependency where
  upstream : String
  kind : ClaimDependencyKind
  semanticIdentity : Option String := none
  deriving Repr, BEq, DecidableEq

structure ClaimEffect where
  resource : String
  desired : String
  sameDesiredCommutes : Bool
  deriving Repr, BEq, DecidableEq

structure ClaimObligation where
  id : String
  dependencies : List ClaimDependency
  effect : Option ClaimEffect := none
  deriving Repr, BEq, DecidableEq

structure ClaimLifecycleFact where
  obligationId : String
  status : ClaimLifecycle
  deriving Repr, BEq, DecidableEq

structure ClaimContext where
  currentRevision : String
  expectedRevision : String
  targetId : String
  obligations : List ClaimObligation
  lifecycles : List ClaimLifecycleFact
  deriving Repr, BEq, DecidableEq

def claimObligationIds (ctx : ClaimContext) : List String :=
  ctx.obligations.map (fun obligation => obligation.id)

def claimLifecycleIds (ctx : ClaimContext) : List String :=
  ctx.lifecycles.map (fun lifecycle => lifecycle.obligationId)

private def uniqueStringsAux (seen : Std.HashSet String) : List String → Bool
  | [] => true
  | value :: rest =>
      let (alreadyPresent, nextSeen) := seen.containsThenInsert value
      !alreadyPresent && uniqueStringsAux nextSeen rest

def uniqueStrings (values : List String) : Bool :=
  uniqueStringsAux (Std.HashSet.emptyWithCapacity values.length) values

def findClaimObligation
    (obligations : List ClaimObligation)
    (id : String) : Option ClaimObligation :=
  obligations.find? (fun obligation => obligation.id == id)

def findClaimLifecycle
    (lifecycles : List ClaimLifecycleFact)
    (id : String) : Option ClaimLifecycle :=
  match lifecycles.find? (fun lifecycle => lifecycle.obligationId == id) with
  | none => none
  | some lifecycle => some lifecycle.status

def claimDependsOnWithFuel
    (obligations : List ClaimObligation)
    (fromId targetId : String) :
    Nat → Bool
  | 0 => false
  | fuel + 1 =>
      if fromId == targetId then
        true
      else
        match findClaimObligation obligations fromId with
        | none => false
        | some obligation =>
            obligation.dependencies.any (fun dependency =>
              claimDependsOnWithFuel obligations dependency.upstream targetId fuel)

def claimDependsOn
    (obligations : List ClaimObligation)
    (fromId targetId : String) : Bool :=
  claimDependsOnWithFuel obligations fromId targetId (obligations.length + 1)

private def claimObligationIdSet (ctx : ClaimContext) : Std.HashSet String :=
  (Std.HashSet.emptyWithCapacity ctx.obligations.length).insertMany
    (claimObligationIds ctx)

def claimGraphReferencesKnown (ctx : ClaimContext) : Bool :=
  let obligationIds := claimObligationIdSet ctx
  ctx.obligations.all (fun obligation =>
    obligation.dependencies.all (fun dependency =>
      obligationIds.contains dependency.upstream))

def claimGraphAcyclic (ctx : ClaimContext) : Bool :=
  !ctx.obligations.any (fun obligation =>
    obligation.dependencies.any (fun dependency =>
      claimDependsOn ctx.obligations dependency.upstream obligation.id))

private def claimLifecycleIdSet (ctx : ClaimContext) : Std.HashSet String :=
  (Std.HashSet.emptyWithCapacity ctx.lifecycles.length).insertMany
    (claimLifecycleIds ctx)

def claimLifecycleCoverage (ctx : ClaimContext) : Bool :=
  let lifecycleIds := claimLifecycleIdSet ctx
  ctx.obligations.all (fun obligation =>
    lifecycleIds.contains obligation.id)

def claimContextWellFormed (ctx : ClaimContext) : Bool :=
  uniqueStrings (claimObligationIds ctx) &&
  uniqueStrings (claimLifecycleIds ctx) &&
  claimGraphReferencesKnown ctx &&
  claimGraphAcyclic ctx &&
  claimLifecycleCoverage ctx

def claimDependenciesDone (ctx : ClaimContext) : Bool :=
  match findClaimObligation ctx.obligations ctx.targetId with
  | none => false
  | some target =>
      target.dependencies.all (fun dependency =>
        findClaimLifecycle ctx.lifecycles dependency.upstream == some .done)

def claimSemanticInputsResolved (ctx : ClaimContext) : Bool :=
  match findClaimObligation ctx.obligations ctx.targetId with
  | none => false
  | some target =>
      target.dependencies.all (fun dependency =>
        match dependency.kind with
        | .control => true
        | .semantic => dependency.semanticIdentity.isSome)

def claimEffectsConflict (left right : ClaimEffect) : Bool :=
  if left.resource != right.resource then
    false
  else if
    left.desired == right.desired &&
    left.sameDesiredCommutes &&
    right.sameDesiredCommutes
  then
    false
  else
    true

def claimUnorderedEffectConflict (ctx : ClaimContext) : Bool :=
  match findClaimObligation ctx.obligations ctx.targetId with
  | none => true
  | some target =>
      match target.effect with
      | none => false
      | some targetEffect =>
          ctx.obligations.any (fun other =>
            if other.id == target.id then
              false
            else
              match other.effect with
              | none => false
              | some otherEffect =>
                  claimEffectsConflict targetEffect otherEffect &&
                  !(claimDependsOn ctx.obligations target.id other.id ||
                    claimDependsOn ctx.obligations other.id target.id))

def claimAdmissible (ctx : ClaimContext) : Bool :=
  claimContextWellFormed ctx &&
  ctx.expectedRevision == ctx.currentRevision &&
  findClaimLifecycle ctx.lifecycles ctx.targetId == some .unrealized &&
  claimDependenciesDone ctx &&
  claimSemanticInputsResolved ctx &&
  !claimUnorderedEffectConflict ctx

end Overcenter
