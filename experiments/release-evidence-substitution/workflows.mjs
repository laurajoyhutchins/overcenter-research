import { proxyActivities } from '@temporalio/workflow';

const retrying=proxyActivities({
  startToCloseTimeout:'2 minutes',
  retry:{
    initialInterval:'15 seconds',
    backoffCoefficient:1,
    maximumAttempts:2,
  },
});

const once=proxyActivities({
  startToCloseTimeout:'2 minutes',
  retry:{maximumAttempts:1},
});

export async function interruptedReleaseWorkflow(input) {
  return await retrying.releaseActivity(input);
}

export async function replacementReleaseWorkflow(input) {
  return await once.releaseActivity(input);
}
