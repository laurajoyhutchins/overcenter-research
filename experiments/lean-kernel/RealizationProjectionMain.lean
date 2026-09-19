import Overcenter.RealizationProjectionProtocol

open Overcenter.RealizationProjectionProtocol

def main : IO UInt32 := do
  let stdin ← IO.getStdin
  let input ← stdin.readToEnd
  if input.trim.isEmpty then
    IO.println "Overcenter Lean realization projection: proofs type-checked."
    IO.println "Protocol: JSON stdin/stdout; command=realization-project."
    return 0
  match handle input with
  | .ok output =>
      IO.println output
      return 0
  | .error error =>
      IO.eprintln s!"OVER CENTER LEAN REALIZATION PROJECTION INPUT REJECTED: {error}"
      return 2
