import Lake
open Lake DSL

package overcenterLeanKernel where
  version := v!"0.1.0"

lean_lib Overcenter

@[default_target]
lean_exe overcenterKernel where
  root := `Main

lean_exe overcenterClaimAdmission where
  root := `AdmissionMain

lean_exe overcenterClaimAdmissionServer where
  root := `AdmissionServerMain

lean_exe overcenterClaimAdmissionComparisonServer where
  root := `AdmissionComparisonServerMain

lean_exe overcenterSemanticIdentity where
  root := `SemanticIdentityMain

lean_exe overcenterObligationKeyPreimage where
  root := `KeyPreimageMain

lean_exe overcenterRealizationProjection where
  root := `RealizationProjectionMain
