namespace Overcenter

inductive VerifierFamily where
  | immutableArtifact
  | fileContent
  | eventuallyConsistentFileContent
  | githubCommitStatus
  | kubernetesConfigMapExists
  deriving Repr, BEq, DecidableEq

inductive MutationCertainty where
  | present
  | absent
  | uncertain
  deriving Repr, BEq, DecidableEq

inductive AbsenceKind where
  | localFileEnoent
  | kubernetesCompleteList
  deriving Repr, BEq, DecidableEq

inductive Disposition where
  | done
  | ready
  | recoveryRequired
  deriving Repr, BEq, DecidableEq

inductive RealizationStability where
  | immutable
  | mutableExternal
  deriving Repr, BEq, DecidableEq

structure Postcondition where
  family : VerifierFamily
  verifierRevision : String
  coordinate : String
  expected : String
  deriving Repr, BEq, DecidableEq

structure AbsenceEvidence where
  kind : AbsenceKind
  coordinate : String
  complete : Bool
  deriving Repr, BEq, DecidableEq

structure Observation where
  family : VerifierFamily
  verifierRevision : String
  coordinate : String
  certainty : MutationCertainty
  actual : Option String
  absence : Option AbsenceEvidence := none
  deriving Repr, BEq, DecidableEq

structure Obligation where
  id : String
  packetIdentity : String
  postcondition : Postcondition
  semanticInputs : List String
  deriving Repr, BEq, DecidableEq

structure ObligationKey where
  id : String
  packetIdentity : String
  family : VerifierFamily
  verifierRevision : String
  coordinate : String
  expected : String
  semanticInputs : List String
  deriving Repr, BEq, DecidableEq

structure HistoricalRealization where
  key : ObligationKey
  disposition : Disposition
  deriving Repr, BEq, DecidableEq

end Overcenter
