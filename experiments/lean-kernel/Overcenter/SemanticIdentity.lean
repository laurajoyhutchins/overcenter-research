import Overcenter.Admission

namespace Overcenter

inductive SemanticSelector where
  | verifiedContent
  | settlementReceipt
  deriving Repr, BEq, DecidableEq

inductive SemanticOutputMaterial where
  | contentSha256 (digest : String)
  | githubCommitStatus
      (repositoryId : String)
      (commitSha : String)
      (context : String)
      (state : String)
  | kubernetesExists
      (authorityId : String)
      (apiGroup : String)
      (resource : String)
      (namespaceName : String)
      (name : String)
  deriving Repr, BEq, DecidableEq

inductive SemanticIdentityMaterial where
  | output (material : SemanticOutputMaterial)
  | settlementReceipt (commit : String)
  deriving Repr, BEq, DecidableEq

structure RawClaimDependency where
  upstream : String
  kind : ClaimDependencyKind
  selector : Option SemanticSelector := none
  deriving Repr, BEq, DecidableEq

structure RawClaimObligation where
  id : String
  dependencies : List RawClaimDependency
  semanticOutput : Option SemanticOutputMaterial := none
  effect : Option ClaimEffect := none
  deriving Repr, BEq, DecidableEq

structure RawClaimLifecycleFact where
  obligationId : String
  status : ClaimLifecycle
  runId : Option String := none
  deriving Repr, BEq, DecidableEq

inductive RawReceiptDisposition where
  | done
  | ready
  | waiting
  | recoveryRequired
  deriving Repr, BEq, DecidableEq

structure RawSettlementReceiptFact where
  runId : String
  obligationId : String
  disposition : RawReceiptDisposition
  settlementCommit : Option String := none
  deriving Repr, BEq, DecidableEq

structure RawClaimContext where
  currentRevision : String
  expectedRevision : String
  targetId : String
  obligations : List RawClaimObligation
  lifecycles : List RawClaimLifecycleFact
  receipts : List RawSettlementReceiptFact
  deriving Repr, BEq, DecidableEq

def rawObligationIds (ctx : RawClaimContext) : List String :=
  ctx.obligations.map (fun obligation => obligation.id)

def rawLifecycleIds (ctx : RawClaimContext) : List String :=
  ctx.lifecycles.map (fun lifecycle => lifecycle.obligationId)

def rawReceiptRunIds (ctx : RawClaimContext) : List String :=
  ctx.receipts.map (fun receipt => receipt.runId)

def findRawObligation
    (obligations : List RawClaimObligation)
    (id : String) : Option RawClaimObligation :=
  obligations.find? (fun obligation => obligation.id == id)

def findRawLifecycleFact
    (lifecycles : List RawClaimLifecycleFact)
    (id : String) : Option RawClaimLifecycleFact :=
  lifecycles.find? (fun lifecycle => lifecycle.obligationId == id)

def findRawReceipt
    (receipts : List RawSettlementReceiptFact)
    (runId : String) : Option RawSettlementReceiptFact :=
  receipts.find? (fun receipt => receipt.runId == runId)

def rawDependencyShapeValid (dependency : RawClaimDependency) : Bool :=
  match dependency.kind, dependency.selector with
  | .control, none => true
  | .semantic, some _ => true
  | _, _ => false

def rawLifecycleShapeValid (lifecycle : RawClaimLifecycleFact) : Bool :=
  match lifecycle.status, lifecycle.runId with
  | .unrealized, none => true
  | .unrealized, some _ => false
  | _, some runId => !runId.isEmpty
  | _, none => false

def rawGraphReferencesKnown (ctx : RawClaimContext) : Bool :=
  ctx.obligations.all (fun obligation =>
    obligation.dependencies.all (fun dependency =>
      ctx.obligations.any (fun candidate => candidate.id == dependency.upstream)))

def rawContextBasicWellFormed (ctx : RawClaimContext) : Bool :=
  uniqueStrings (rawObligationIds ctx) &&
  uniqueStrings (rawLifecycleIds ctx) &&
  uniqueStrings (rawReceiptRunIds ctx) &&
  rawGraphReferencesKnown ctx &&
  ctx.obligations.all (fun obligation =>
    obligation.dependencies.all rawDependencyShapeValid) &&
  ctx.lifecycles.all rawLifecycleShapeValid &&
  ctx.obligations.all (fun obligation =>
    ctx.lifecycles.any (fun lifecycle => lifecycle.obligationId == obligation.id))

def deriveSemanticIdentityMaterial
    (ctx : RawClaimContext)
    (dependency : RawClaimDependency) : Option SemanticIdentityMaterial :=
  match dependency.kind, dependency.selector with
  | .control, _ => none
  | .semantic, none => none
  | .semantic, some selector =>
      match findRawObligation ctx.obligations dependency.upstream,
            findRawLifecycleFact ctx.lifecycles dependency.upstream with
      | some upstream, some lifecycle =>
          if lifecycle.status != .done then
            none
          else
            match selector with
            | .verifiedContent =>
                match upstream.semanticOutput with
                | some material => some (.output material)
                | none => none
            | .settlementReceipt =>
                match lifecycle.runId with
                | none => none
                | some runId =>
                    match findRawReceipt ctx.receipts runId with
                    | none => none
                    | some receipt =>
                        if receipt.obligationId != dependency.upstream then
                          none
                        else if receipt.disposition != .done then
                          none
                        else
                          match receipt.settlementCommit with
                          | some commit =>
                              if commit.isEmpty then none else some (.settlementReceipt commit)
                          | none => none
      | _, _ => none

def rawSemanticInputsResolved (ctx : RawClaimContext) : Bool :=
  match findRawObligation ctx.obligations ctx.targetId with
  | none => false
  | some target =>
      target.dependencies.all (fun dependency =>
        match dependency.kind with
        | .control => true
        | .semantic => (deriveSemanticIdentityMaterial ctx dependency).isSome)

def rawDependencyToBase
    (ctx : RawClaimContext)
    (dependency : RawClaimDependency) : ClaimDependency :=
  match dependency.kind with
  | .control => {
      upstream := dependency.upstream
      kind := .control
      semanticIdentity := none
    }
  | .semantic => {
      upstream := dependency.upstream
      kind := .semantic
      semanticIdentity :=
        if (deriveSemanticIdentityMaterial ctx dependency).isSome
        then some "derived-by-lean"
        else none
    }

def rawObligationToBase
    (ctx : RawClaimContext)
    (obligation : RawClaimObligation) : ClaimObligation := {
  id := obligation.id
  dependencies := obligation.dependencies.map (rawDependencyToBase ctx)
  effect := obligation.effect
}

def rawLifecycleToBase
    (lifecycle : RawClaimLifecycleFact) : ClaimLifecycleFact := {
  obligationId := lifecycle.obligationId
  status := lifecycle.status
}

def rawToBaseClaimContext (ctx : RawClaimContext) : ClaimContext := {
  currentRevision := ctx.currentRevision
  expectedRevision := ctx.expectedRevision
  targetId := ctx.targetId
  obligations := ctx.obligations.map (rawObligationToBase ctx)
  lifecycles := ctx.lifecycles.map rawLifecycleToBase
}

def derivedClaimAdmissible (ctx : RawClaimContext) : Bool :=
  rawContextBasicWellFormed ctx &&
  rawSemanticInputsResolved ctx &&
  claimAdmissible (rawToBaseClaimContext ctx)

end Overcenter
