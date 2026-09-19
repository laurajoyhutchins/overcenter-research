import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.SemanticIdentityProofs

open Lean

namespace Overcenter

structure KeyHashResult where
  bytes : String
  digest : String
  deriving Repr, BEq, DecidableEq

structure ObligationKeyInput where
  context : RawClaimContext
  packet : Json
  postcondition : Json

def semanticDependencies (ctx : RawClaimContext) : List RawClaimDependency :=
  match findRawObligation ctx.obligations ctx.targetId with
  | none => []
  | some target =>
      target.dependencies.filter (fun dependency => dependency.kind == .semantic)

def semanticDependencyFingerprint (dependency : RawClaimDependency) : String :=
  let selector :=
    match dependency.selector with
    | none => ""
    | some .verifiedContent => "verified-content"
    | some .settlementReceipt => "settlement-receipt"
  dependency.upstream ++ "\u0000" ++ selector

def semanticDependenciesUnique (ctx : RawClaimContext) : Bool :=
  uniqueStrings ((semanticDependencies ctx).map semanticDependencyFingerprint)

def keyPreimageReady (ctx : RawClaimContext) : Bool :=
  rawContextBasicWellFormed ctx &&
  rawSemanticInputsResolved ctx &&
  semanticDependenciesUnique ctx

def stringLessOrEqual (left right : String) : Bool :=
  match compare left right with
  | .gt => false
  | _ => true

def insertSortedString (value : String) : List String → List String
  | [] => [value]
  | head :: tail =>
      if stringLessOrEqual value head
      then value :: head :: tail
      else head :: insertSortedString value tail

def sortStrings : List String → List String
  | [] => []
  | head :: tail => insertSortedString head (sortStrings tail)

def uniqueSortedStrings (values : List String) : List String :=
  (sortStrings values).foldr
    (fun value acc =>
      match acc with
      | [] => [value]
      | head :: _ => if value == head then acc else value :: acc)
    []

def semanticIdentityHashBytes : SemanticIdentityMaterial → Option String
  | .output (.contentSha256 _) => none
  | .settlementReceipt _ => none
  | .output (.githubCommitStatus repositoryId commitSha context state) =>
      match Json.parse repositoryId with
      | .error _ => none
      | .ok repositoryIdJson =>
          match repositoryIdJson.getNat? with
          | .error _ => none
          | .ok _ =>
              some <| (Json.mkObj [
                ("provider", "github"),
                ("repository_id", repositoryIdJson),
                ("commit_sha", commitSha),
                ("context", context),
                ("state", state)
              ]).compress
  | .output (.kubernetesExists authorityId apiGroup resource namespaceName name) =>
      some <| (Json.mkObj [
        ("provider", "kubernetes"),
        ("authority_id", authorityId),
        ("api_group", apiGroup),
        ("resource", resource),
        ("namespace", namespaceName),
        ("name", name),
        ("state", "exists")
      ]).compress

def plannedIdentityHashBytes (ctx : RawClaimContext) : Option (List String) :=
  if !keyPreimageReady ctx then
    none
  else
    let materials := (semanticDependencies ctx).map (deriveSemanticIdentityMaterial ctx)
    if materials.any Option.isNone then
      none
    else
      let bytes := materials.filterMap (fun material =>
        material.bind semanticIdentityHashBytes)
      some (uniqueSortedStrings bytes)

def hashResultsValid
    (planned : List String)
    (results : List KeyHashResult) : Bool :=
  uniqueStrings (results.map (fun result => result.bytes)) &&
  sortStrings (results.map (fun result => result.bytes)) == sortStrings planned &&
  results.all (fun result => !result.digest.isEmpty)

def findHashDigest (results : List KeyHashResult) (bytes : String) : Option String :=
  match results.find? (fun result => result.bytes == bytes) with
  | none => none
  | some result => some result.digest

def identityString
    (results : List KeyHashResult) :
    SemanticIdentityMaterial → Option String
  | .output (.contentSha256 digest) => some ("sha256:" ++ digest)
  | .settlementReceipt commit => some ("settlement:" ++ commit)
  | material =>
      match semanticIdentityHashBytes material with
      | none => none
      | some bytes => findHashDigest results bytes

def consumesJson : SemanticSelector → Json
  | .verifiedContent =>
      Json.mkObj [
        ("kind", "output"),
        ("selector", "verified-content")
      ]
  | .settlementReceipt =>
      Json.mkObj [
        ("kind", "evidence"),
        ("selector", "settlement-receipt")
      ]

def consumedDependencyJson
    (ctx : RawClaimContext)
    (results : List KeyHashResult)
    (dependency : RawClaimDependency) : Option Json := do
  let selector ← dependency.selector
  let material ← deriveSemanticIdentityMaterial ctx dependency
  let identity ← identityString results material
  pure <| Json.mkObj [
    ("consumes", consumesJson selector),
    ("identity", identity)
  ]

def insertSortedJson (value : Json) : List Json → List Json
  | [] => [value]
  | head :: tail =>
      if stringLessOrEqual value.compress head.compress
      then value :: head :: tail
      else head :: insertSortedJson value tail

def sortJsonByCompressed : List Json → List Json
  | [] => []
  | head :: tail => insertSortedJson head (sortJsonByCompressed tail)

def buildConsumedDependencies
    (ctx : RawClaimContext)
    (results : List KeyHashResult) : Option (List Json) := do
  let entries ← (semanticDependencies ctx).mapM (consumedDependencyJson ctx results)
  pure (sortJsonByCompressed entries)

def buildObligationKeyPreimage
    (input : ObligationKeyInput)
    (results : List KeyHashResult) : Option String := do
  let planned ← plannedIdentityHashBytes input.context
  if !hashResultsValid planned results then
    none
  else
    let consumed ← buildConsumedDependencies input.context results
    pure <| (Json.mkObj [
      ("id", input.context.targetId),
      ("packet", input.packet),
      ("postcondition", input.postcondition),
      ("semantic_dependencies", Json.arr consumed.toArray)
    ]).compress

end Overcenter
