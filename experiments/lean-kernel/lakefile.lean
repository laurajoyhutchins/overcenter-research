import Lake
open Lake DSL

package overcenterLeanKernel where
  version := v!"0.1.0"

lean_lib Overcenter

@[default_target]
lean_exe overcenterKernel where
  root := `Main
