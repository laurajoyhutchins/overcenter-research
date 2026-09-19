import Std.Data.HashMap
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

private def claimObligationIndexFromList
    (obligations : List ClaimObligation) :
    Std.HashMap String ClaimObligation :=
  (Std.HashMap.emptyWithCapacity obligations.length).insertMany
    (obligations.map (fun obligation => (obligation.id, obligation)))

private def claimDependentsIndex (ctx : ClaimContext) :
    Std.HashMap String (List String) :=
  ctx.obligations.foldl
    (fun dependents obligation =>
      obligation.dependencies.foldl
        (fun dependents dependency =>
          dependents.alter dependency.upstream (fun current =>
            some (obligation.id :: current.getD [])))
        dependents)
    (Std.HashMap.emptyWithCapacity ctx.obligations.length)

private def claimIndegreeIndex (ctx : ClaimContext) :
    Std.HashMap String Nat :=
  ctx.obligations.foldl
    (fun indegree obligation =>
      indegree.insert obligation.id obligation.dependencies.length)
    (Std.HashMap.emptyWithCapacity ctx.obligations.length)

private def claimZeroIndegreeQueue (ctx : ClaimContext) : List String :=
  ctx.obligations.foldl
    (fun queue obligation =>
      if obligation.dependencies.isEmpty then
        obligation.id :: queue
      else
        queue)
    []

private def releaseClaimDependents :
    List String →
    Std.HashMap String Nat →
    List String →
    Option (Std.HashMap String Nat × List String)
  | [], indegree, queue => some (indegree, queue)
  | dependent :: rest, indegree, queue =>
      match indegree[dependent]? with
      | none => none
      | some 0 => none
      | some (Nat.succ prior) =>
          let indegree := indegree.insert dependent prior
          let queue :=
            if prior == 0 then
              dependent :: queue
            else
              queue
          releaseClaimDependents rest indegree queue

private def claimKahnLoop
    (dependents : Std.HashMap String (List String)) :
    Std.HashMap String Nat →
    List String →
    List String →
    Nat →
    Option (List String)
  | _, _, processed, 0 => some processed.reverse
  | _, [], processed, _ + 1 => some processed.reverse
  | indegree, node :: queue, processed, fuel + 1 =>
      let released :=
        releaseClaimDependents
          ((dependents[node]?).getD [])
          indegree
          queue
      match released with
      | none => none
      | some (indegree, queue) =>
          claimKahnLoop
            dependents
            indegree
            queue
            (node :: processed)
            fuel

def claimGraphTopologicalOrder? (ctx : ClaimContext) :
    Option (List String) :=
  if !uniqueStrings (claimObligationIds ctx) then
    none
  else
    let dependents := claimDependentsIndex ctx
    let indegree := claimIndegreeIndex ctx
    let queue := claimZeroIndegreeQueue ctx
    match
      claimKahnLoop
        dependents
        indegree
        queue
        []
        ctx.obligations.length
    with
    | none => none
    | some order =>
        if order.length == ctx.obligations.length then
          some order
        else
          none

def claimTopologicalCertificateBuildValid
    (ctx : ClaimContext) :
    List String →
    List String →
    Bool
  | _, [] => true
  | seen, id :: rest =>
      match findClaimObligation ctx.obligations id with
      | none => false
      | some obligation =>
          obligation.dependencies.all (fun dependency =>
            seen.contains dependency.upstream) &&
          claimTopologicalCertificateBuildValid
            ctx
            (id :: seen)
            rest

def claimTopologicalCertificateValid
    (ctx : ClaimContext)
    (order : List String) : Bool :=
  ctx.obligations.all (fun obligation =>
    order.contains obligation.id) &&
  claimTopologicalCertificateBuildValid ctx [] order

def claimGraphAcyclic (ctx : ClaimContext) : Bool :=
  match claimGraphTopologicalOrder? ctx with
  | none => false
  | some order => claimTopologicalCertificateValid ctx order

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

private def claimDependsOnIndexedWithFuel
    (obligations : Std.HashMap String ClaimObligation)
    (fromId targetId : String) :
    Nat → Bool
  | 0 => false
  | fuel + 1 =>
      if fromId == targetId then
        true
      else
        match obligations[fromId]? with
        | none => false
        | some obligation =>
            obligation.dependencies.any (fun dependency =>
              claimDependsOnIndexedWithFuel
                obligations
                dependency.upstream
                targetId
                fuel)

private def claimDependsOnIndexed
    (obligations : Std.HashMap String ClaimObligation)
    (obligationCount : Nat)
    (fromId targetId : String) : Bool :=
  claimDependsOnIndexedWithFuel
    obligations
    fromId
    targetId
    (obligationCount + 1)

def claimUnorderedEffectConflict (ctx : ClaimContext) : Bool :=
  match findClaimObligation ctx.obligations ctx.targetId with
  | none => true
  | some target =>
      match target.effect with
      | none => false
      | some targetEffect =>
          let obligationIndex :=
            claimObligationIndexFromList ctx.obligations
          ctx.obligations.any (fun other =>
            if other.id == target.id then
              false
            else
              match other.effect with
              | none => false
              | some otherEffect =>
                  claimEffectsConflict targetEffect otherEffect &&
                  !(claimDependsOnIndexed
                      obligationIndex
                      ctx.obligations.length
                      target.id
                      other.id ||
                    claimDependsOnIndexed
                      obligationIndex
                      ctx.obligations.length
                      other.id
                      target.id))

def claimAdmissible (ctx : ClaimContext) : Bool :=
  claimContextWellFormed ctx &&
  ctx.expectedRevision == ctx.currentRevision &&
  findClaimLifecycle ctx.lifecycles ctx.targetId == some .unrealized &&
  claimDependenciesDone ctx &&
  claimSemanticInputsResolved ctx &&
  !claimUnorderedEffectConflict ctx

end Overcenter
