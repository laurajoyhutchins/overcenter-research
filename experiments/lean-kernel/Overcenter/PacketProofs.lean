import Std.Tactic
import Overcenter.Packet

namespace Overcenter

private def packet (input : String) : PacketValue :=
  (parsePacketValue input).toOption.getD .null

example :
    packet "{\"b\":2,\"a\":1}" =
    packet "{\"a\":1,\"b\":2}" := by native_decide

example :
    packet "{\"z\":{\"b\":2,\"a\":1},\"a\":[true,null]}" =
    packet "{\"a\":[true,null],\"z\":{\"a\":1,\"b\":2}}" := by native_decide

example :
    packet "{\"n\":1}" =
    packet "{\"n\":1.0}" := by native_decide

example :
    packet "{\"n\":1.00e0}" =
    packet "{\"n\":1}" := by native_decide

example :
    packet "[1,2]" != packet "[2,1]" := by native_decide

example :
    packet "{\"a\":1}" != packet "{\"a\":2}" := by native_decide

example :
    packet "{\"a\":1}" != packet "{\"a\":\"1\"}" := by native_decide

end Overcenter
