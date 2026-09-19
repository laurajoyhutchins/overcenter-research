namespace Overcenter

structure PacketNumber where
  sign : Int
  mantissa : Nat
  exponent : Int
  deriving Repr, BEq, DecidableEq

inductive PacketValue where
  | null
  | bool (value : Bool)
  | number (value : PacketNumber)
  | string (value : String)
  | array (values : List PacketValue)
  | object (fields : List (String × PacketValue))
  deriving Repr, BEq, DecidableEq

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

inductive Disposition where
  | done
  | ready
  | recoveryRequired
  deriving Repr, BEq, DecidableEq

inductive RealizationStability where
  | immutable
  | mutableExternal
  deriving Repr, BEq, DecidableEq

inductive Coordinate where
  | opaque (value : String)
  | githubCommitStatus
      (repositoryId : Nat)
      (commitSha : String)
      (context : String)
  | kubernetesConfigMap (authorityId : String) (namespaceName : String) (name : String)
  deriving Repr, BEq, DecidableEq

structure Postcondition where
  family : VerifierFamily
  verifierRevision : String
  coordinate : Coordinate
  expected : String
  deriving Repr, BEq, DecidableEq

structure KubernetesListMember where
  name : String
  namespaceName : String
  uid : String
  resourceVersion : String
  deriving Repr, BEq, DecidableEq

structure KubernetesListPage where
  authorityId : String
  requestNamespace : String
  requestContinue : Option String
  responseContinue : String
  snapshotResourceVersion : String
  members : List KubernetesListMember
  deriving Repr, BEq, DecidableEq

inductive KubernetesWatchEventType where
  | added
  | modified
  | deleted
  deriving Repr, BEq, DecidableEq

inductive KubernetesWatchTermination where
  | clientStop
  | eof
  | timeout
  | gone
  | error
  deriving Repr, BEq, DecidableEq

structure KubernetesWatchEvent where
  eventType : KubernetesWatchEventType
  member : KubernetesListMember
  deriving Repr, BEq, DecidableEq

structure KubernetesWatchTranscript where
  authorityId : String
  requestNamespace : String
  startResourceVersion : String
  termination : KubernetesWatchTermination
  events : List KubernetesWatchEvent
  deriving Repr, BEq, DecidableEq

inductive AbsenceEvidence where
  | localFileEnoent
      (subjectCoordinate : String)
      (scopeCoordinate : String)
      (snapshotIsNull : Bool)
      (completenessKind : String)
      (completenessResult : String)
      (provenanceAdapter : String)
      (provenanceOperation : String)
      (provenanceErrorCode : String)
  | kubernetesCompleteList
      (authorityId : String)
      (namespaceName : String)
      (targetName : String)
      (snapshotResourceVersion : String)
      (pages : List KubernetesListPage)
  deriving Repr, BEq, DecidableEq

structure Observation where
  family : VerifierFamily
  verifierRevision : String
  coordinate : Coordinate
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
  coordinate : Coordinate
  expected : String
  semanticInputs : List String
  deriving Repr, BEq, DecidableEq

structure HistoricalRealization where
  key : ObligationKey
  disposition : Disposition
  deriving Repr, BEq, DecidableEq

end Overcenter
