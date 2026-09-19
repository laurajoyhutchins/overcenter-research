import Std.Data.HashSet.Lemmas
import Overcenter.Admission

namespace Overcenter

/--
A proposition-level topological construction. The seen list contains obligation IDs
that occur earlier in the proposed order. Each next obligation may be appended only
when every dependency is already in seen.

This is intentionally separate from Kahn's executable implementation and from the
hash-set representation used by the certificate checker.
-/
inductive ClaimTopologicalBuild
    (ctx : ClaimContext) :
    List String →
    List String →
    Prop where
  | done (seen : List String) :
      ClaimTopologicalBuild ctx seen []
  | step
      (seen : List String)
      (id : String)
      (rest : List String)
      (obligation : ClaimObligation)
      (obligation_mem : obligation ∈ ctx.obligations)
      (id_exact : obligation.id = id)
      (dependencies_precede :
        ∀ dependency,
          dependency ∈ obligation.dependencies →
          dependency.upstream ∈ seen)
      (rest_valid :
        ClaimTopologicalBuild ctx (id :: seen) rest) :
      ClaimTopologicalBuild ctx seen (id :: rest)

/--
Independent graph property used by the admission proof surface: every obligation
is covered by an order that can be built by repeatedly appending only nodes whose
dependencies already occurred.
-/
def ClaimHasTopologicalOrder (ctx : ClaimContext) : Prop :=
  ∃ order,
    (∀ obligation,
      obligation ∈ ctx.obligations →
      obligation.id ∈ order) ∧
    ClaimTopologicalBuild ctx [] order

private theorem findClaimObligation_mem
    {obligations : List ClaimObligation}
    {id : String}
    {obligation : ClaimObligation}
    (h : findClaimObligation obligations id = some obligation) :
    obligation ∈ obligations := by
  have hfind :
      obligations.find? (fun candidate => candidate.id == id) =
        some obligation := by
    simpa [findClaimObligation] using h
  exact List.mem_of_find?_eq_some hfind

private theorem findClaimObligation_id_exact
    {obligations : List ClaimObligation}
    {id : String}
    {obligation : ClaimObligation}
    (h : findClaimObligation obligations id = some obligation) :
    obligation.id = id := by
  have hfind :
      obligations.find? (fun candidate => candidate.id == id) =
        some obligation := by
    simpa [findClaimObligation] using h
  have hp :
      (fun candidate : ClaimObligation => candidate.id == id) obligation =
        true :=
    (List.find?_eq_some_iff_append.mp hfind).1
  simpa using hp

theorem claimStringSet_contains_iff_mem
    (values : List String)
    (id : String) :
    (claimStringSet values).contains id = true ↔
      id ∈ values := by
  induction values with
  | nil =>
      simp [claimStringSet]
  | cons value rest ih =>
      simp [claimStringSet, ih]

theorem claimTopologicalCertificateBuildValid_sound
    (ctx : ClaimContext)
    (seen order : List String)
    (accepted :
      claimTopologicalCertificateBuildValid
        ctx
        (claimStringSet seen)
        order = true) :
    ClaimTopologicalBuild ctx seen order := by
  induction order generalizing seen with
  | nil =>
      exact ClaimTopologicalBuild.done seen
  | cons id rest ih =>
      cases hfind :
          findClaimObligation ctx.obligations id with
      | none =>
          simp [
            claimTopologicalCertificateBuildValid,
            hfind
          ] at accepted
      | some obligation =>
          have parts :
              obligation.dependencies.all (fun dependency =>
                (claimStringSet seen).contains dependency.upstream) = true ∧
              claimTopologicalCertificateBuildValid
                ctx
                ((claimStringSet seen).insert id)
                rest = true := by
            simpa [
              claimTopologicalCertificateBuildValid,
              hfind
            ] using accepted
          have dependencies_precede :
              ∀ dependency,
                dependency ∈ obligation.dependencies →
                dependency.upstream ∈ seen := by
            intro dependency dependency_mem
            have contained :
                (claimStringSet seen).contains dependency.upstream = true :=
              (List.all_eq_true.mp parts.1)
                dependency
                dependency_mem
            exact
              (claimStringSet_contains_iff_mem
                seen
                dependency.upstream).mp contained
          have restAccepted :
              claimTopologicalCertificateBuildValid
                ctx
                (claimStringSet (id :: seen))
                rest = true := by
            simpa [claimStringSet] using parts.2
          exact ClaimTopologicalBuild.step
            seen
            id
            rest
            obligation
            (findClaimObligation_mem hfind)
            (findClaimObligation_id_exact hfind)
            dependencies_precede
            (ih (id :: seen) restAccepted)

theorem claimTopologicalCertificateValid_sound
    (ctx : ClaimContext)
    (order : List String)
    (accepted :
      claimTopologicalCertificateValid ctx order = true) :
    ClaimHasTopologicalOrder ctx := by
  have parts :
      ctx.obligations.all (fun obligation =>
        (claimStringSet order).contains obligation.id) = true ∧
      claimTopologicalCertificateBuildValid
        ctx
        (claimStringSet [])
        order = true := by
    simpa [claimTopologicalCertificateValid] using accepted
  refine ⟨order, ?_, ?_⟩
  · intro obligation obligation_mem
    have contained :
        (claimStringSet order).contains obligation.id = true :=
      (List.all_eq_true.mp parts.1)
        obligation
        obligation_mem
    exact
      (claimStringSet_contains_iff_mem
        order
        obligation.id).mp contained
  · exact
      claimTopologicalCertificateBuildValid_sound
        ctx
        []
        order
        parts.2

theorem claimGraphAcyclic_sound
    (ctx : ClaimContext)
    (accepted : claimGraphAcyclic ctx = true) :
    ClaimHasTopologicalOrder ctx := by
  unfold claimGraphAcyclic at accepted
  cases horder : claimGraphTopologicalOrder? ctx with
  | none =>
      simp [horder] at accepted
  | some order =>
      have certificate :
          claimTopologicalCertificateValid ctx order = true := by
        simpa [horder] using accepted
      exact
        claimTopologicalCertificateValid_sound
          ctx
          order
          certificate

end Overcenter
