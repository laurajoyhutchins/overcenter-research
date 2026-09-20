import { activityInfo } from '@temporalio/activity';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function kubectl(args,{input}={}) {
  return execFileSync('kubectl',args,{
    encoding:'utf8',
    ...(input===undefined?{}:{input}),
  });
}

function deploymentJson(namespace,name) {
  return JSON.parse(kubectl(['get','deployment',name,'-n',namespace,'-o','json']));
}

function manifest(input) {
  return JSON.stringify({
    apiVersion:'apps/v1',
    kind:'Deployment',
    metadata:{
      name:input.name,
      namespace:input.namespace,
      annotations:{
        'overcenter.dev/obligation-key':input.obligationKey,
        'overcenter.dev/effect-identity':input.effectIdentity,
        'overcenter.dev/source-commit':input.commit,
      },
    },
    spec:{
      replicas:1,
      selector:{matchLabels:{app:'release-evidence-substitution'}},
      template:{
        metadata:{
          labels:{app:'release-evidence-substitution'},
          annotations:{
            'overcenter.dev/obligation-key':input.obligationKey,
            'overcenter.dev/effect-identity':input.effectIdentity,
            'overcenter.dev/source-commit':input.commit,
          },
        },
        spec:{
          containers:[{
            name:'pause',
            image:input.image,
            imagePullPolicy:'IfNotPresent',
          }],
        },
      },
    },
  });
}

function applyAndWait(input,{recreate=false}={}) {
  if (recreate) {
    kubectl([
      'delete','deployment',input.name,
      '-n',input.namespace,
      '--ignore-not-found=true',
      '--wait=true',
    ]);
  }
  kubectl(['apply','-f','-'],{input:manifest(input)});
  kubectl([
    'rollout','status',
    `deployment/${input.name}`,
    '-n',input.namespace,
    '--timeout=90s',
  ]);
  return deploymentJson(input.namespace,input.name);
}

function conventionalRecoveryAccepts(input,observed) {
  const container=observed.spec?.template?.spec?.containers?.[0];
  return observed.metadata?.namespace===input.namespace
    && observed.metadata?.name===input.name
    && container?.image===input.image
    && observed.status?.observedGeneration===observed.metadata?.generation
    && Number(observed.spec?.replicas??0)>0
    && observed.status?.availableReplicas===observed.spec?.replicas;
}

function summary(observed) {
  return {
    uid:observed.metadata?.uid??null,
    generation:observed.metadata?.generation??null,
    observedGeneration:observed.status?.observedGeneration??null,
    image:observed.spec?.template?.spec?.containers?.[0]?.image??null,
    availableReplicas:observed.status?.availableReplicas??0,
    desiredReplicas:observed.spec?.replicas??0,
    obligationKey:observed.metadata?.annotations?.['overcenter.dev/obligation-key']??null,
    effectIdentity:observed.metadata?.annotations?.['overcenter.dev/effect-identity']??null,
    commit:observed.metadata?.annotations?.['overcenter.dev/source-commit']??null,
  };
}

export async function releaseActivity(input) {
  const attempt=activityInfo().attempt;

  if (input.role==='interrupted' && attempt===1) {
    const observed=applyAndWait(input);
    writeFileSync(input.acceptedMarker,JSON.stringify({
      attempt,
      accepted:true,
      observed:summary(observed),
    })+'\n');
    throw new Error('SIMULATED_LOST_ACTIVITY_RESPONSE_AFTER_KUBERNETES_ACCEPT');
  }

  if (input.role==='replacement') {
    const observed=applyAndWait(input,{recreate:true});
    return {
      accepted:true,
      mode:'replacement-applied',
      attempt,
      observed:summary(observed),
    };
  }

  const observed=deploymentJson(input.namespace,input.name);
  const accepted=conventionalRecoveryAccepts(input,observed);
  if (!accepted) {
    throw new Error('CONVENTIONAL_RECOVERY_PREDICATE_REJECTED');
  }
  return {
    accepted:true,
    mode:'conventional-recovery',
    attempt,
    observed:summary(observed),
  };
}
