import Overcenter.AdmissionProtocol

open Overcenter.AdmissionProtocol

partial def serve
    (stdin stdout stderr : IO.FS.Stream) : IO UInt32 := do
  let line ← stdin.getLine
  if line.isEmpty then
    return 0
  if line.trim.isEmpty then
    serve stdin stdout stderr
  else
    match handleComparison line with
    | .ok output =>
        stdout.putStr (output ++ "\n")
        stdout.flush
        serve stdin stdout stderr
    | .error error =>
        stderr.putStr s!"OVER CENTER LEAN CLAIM ADMISSION COMPARISON INPUT REJECTED: {error}\n"
        stderr.flush
        return 2

def main : IO UInt32 := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  let stderr ← IO.getStderr
  serve stdin stdout stderr
