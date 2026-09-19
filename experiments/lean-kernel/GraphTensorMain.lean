import Overcenter.GraphTensorProtocol

open Overcenter.GraphTensorProtocol

def main : IO UInt32 := do
  let stdin ← IO.getStdin
  let input ← stdin.readToEnd
  if input.trim.isEmpty then
    IO.println "Overcenter Lean graph tensor projection: proofs type-checked."
    IO.println "Protocol: JSON stdin/stdout; commands=tensor-project,tensor-verify-two-hop."
    return 0
  match handle input with
  | .ok output =>
      IO.println output
      return 0
  | .error error =>
      IO.eprintln s!"OVER CENTER LEAN GRAPH TENSOR INPUT REJECTED: {error}"
      return 2
