import Lean.Data.Json.Parser
import Overcenter.Model

open Lean

namespace Overcenter

def packetNumberOfJsonNumber (number : JsonNumber) : PacketNumber :=
  let (sign, mantissa, exponent) := number.normalize
  { sign, mantissa, exponent }

partial def packetValueOfJson : Json → PacketValue
  | .null => .null
  | .bool value => .bool value
  | .num value => .number (packetNumberOfJsonNumber value)
  | .str value => .string value
  | .arr values => .array (values.toList.map packetValueOfJson)
  | .obj fields =>
      .object <| fields.foldl (init := []) (fun normalized key value =>
        normalized ++ [(key, packetValueOfJson value)])

def parsePacketValue (input : String) : Except String PacketValue := do
  packetValueOfJson (← Json.parse input)

end Overcenter
