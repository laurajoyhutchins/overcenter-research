import Overcenter.Protocol

open Overcenter.Protocol

def main : IO UInt32 := do
  let stdin ← IO.getStdin
  let input ← stdin.readToEnd
  if input.trim.isEmpty then
    IO.println "Overcenter Lean semantic kernel: proofs type-checked."
    IO.println "Protocol: JSON stdin/stdout; command=settle."
    return 0
  match handle input with
  | .ok output =>
      IO.println output
      return 0
  | .error error =>
      IO.eprintln s!"OVER CENTER LEAN KERNEL INPUT REJECTED: {error}"
      return 2
