import Overcenter.KeyPreimageProtocol

open Overcenter.KeyPreimageProtocol

def main : IO UInt32 := do
  let stdin ← IO.getStdin
  let input ← stdin.readToEnd
  if input.trim.isEmpty then
    IO.println "Overcenter Lean obligation-key preimage kernel: proofs type-checked."
    IO.println "Protocol: JSON stdin/stdout; commands=key-hash-plan,key-preimage."
    return 0
  match handle input with
  | .ok output =>
      IO.println output
      return 0
  | .error error =>
      IO.eprintln s!"OVER CENTER LEAN KEY PREIMAGE INPUT REJECTED: {error}"
      return 2
