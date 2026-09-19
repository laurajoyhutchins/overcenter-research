/*
  Overcenter HolyC graph-kernel Easter egg.

  Pure computation only. No provider access. No persistence.
  No credentials. No settlement authority.

  HolyC may compute facts.
  HolyC may not declare truth.
*/

#define NODE_COUNT 6

U8 *NodeName[NODE_COUNT] = {
  "observe",
  "claim",
  "reserve",
  "execute",
  "verify",
  "settle"
};

Bool Satisfied[NODE_COUNT];
Bool Depends[NODE_COUNT][NODE_COUNT];
I64 FailureCount = 0;

U0 ClearScenario()
{
  I64 node, dependency;

  for (node = 0; node < NODE_COUNT; node++) {
    Satisfied[node] = FALSE;

    for (dependency = 0; dependency < NODE_COUNT; dependency++)
      Depends[node][dependency] = FALSE;
  }
}

U0 AddDependency(I64 node, I64 dependency)
{
  Depends[node][dependency] = TRUE;
}

U0 BuildCanonicalChain()
{
  AddDependency(1, 0);
  AddDependency(2, 1);
  AddDependency(3, 2);
  AddDependency(4, 3);
  AddDependency(5, 4);
}

Bool IsReady(I64 node)
{
  I64 dependency;

  if (Satisfied[node])
    return FALSE;

  for (dependency = 0; dependency < NODE_COUNT; dependency++)
    if (Depends[node][dependency] && !Satisfied[dependency])
      return FALSE;

  return TRUE;
}

I64 ReadyCount()
{
  I64 node, count = 0;

  for (node = 0; node < NODE_COUNT; node++)
    if (IsReady(node))
      count++;

  return count;
}

U0 PrintFrontier()
{
  I64 node;

  "READY:";
  for (node = 0; node < NODE_COUNT; node++)
    if (IsReady(node))
      " %s", NodeName[node];
  "\n";
}

U0 Expect(Bool condition, U8 *label)
{
  if (condition)
    "PASS: %s\n", label;
  else {
    "FAIL: %s\n", label;
    FailureCount++;
  }
}

U0 RunTests()
{
  /*
    Scenario 1:
    In a fresh linear chain, only the first obligation is ready.
  */
  ClearScenario;
  BuildCanonicalChain;
  Expect(IsReady(0), "root is ready");
  Expect(ReadyCount() == 1, "fresh chain has one ready obligation");

  /*
    Scenario 2:
    Once observe, claim, and reserve are satisfied, execute is the frontier.
  */
  Satisfied[0] = TRUE;
  Satisfied[1] = TRUE;
  Satisfied[2] = TRUE;
  Expect(IsReady(3), "execute becomes ready after prerequisites");
  Expect(ReadyCount() == 1, "only execute is ready");
  PrintFrontier;

  /*
    Scenario 3:
    A satisfied node cannot re-enter the frontier.
  */
  Satisfied[3] = TRUE;
  Expect(!IsReady(3), "satisfied obligation is not ready");
  Expect(IsReady(4), "verify becomes ready next");

  /*
    Scenario 4:
    A dependency cycle does not manufacture readiness.
    Graph admission is somebody else's job.
  */
  ClearScenario;
  AddDependency(0, 1);
  AddDependency(1, 0);
  Expect(!IsReady(0), "cycle member zero remains blocked");
  Expect(!IsReady(1), "cycle member one remains blocked");

  /*
    Scenario 5:
    Fully satisfied work has an empty frontier.
  */
  ClearScenario;
  BuildCanonicalChain;
  Satisfied[0] = TRUE;
  Satisfied[1] = TRUE;
  Satisfied[2] = TRUE;
  Satisfied[3] = TRUE;
  Satisfied[4] = TRUE;
  Satisfied[5] = TRUE;
  Expect(ReadyCount() == 0, "fully satisfied graph has empty frontier");

  "\nHolyC frontier checks complete: %d failure(s).\n", FailureCount;
}

/*
  Rejected authority optimization:

  Bool VerifySettlement(Settlement *s)
  {
    return GodSaysDone;
  }

  EVIDENCE_UNAVAILABLE:
  source authority exceeds observer clearance
*/

RunTests;
