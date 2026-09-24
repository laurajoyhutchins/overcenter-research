import assert from 'node:assert/strict';

type WorkerId = string;
type DelegationId = string;

type Fact =
  | { kind: 'worker-start'; worker: WorkerId; generation: number }
  | {
      kind: 'delegation-reserved';
      id: DelegationId;
      parent: WorkerId;
      parent_generation: number;
      child: WorkerId;
      semantic_work: string;
    }
  | { kind: 'delegation-dispatched'; id: DelegationId }
  | { kind: 'delegation-delivered'; id: DelegationId }
  | { kind: 'worker-finished'; worker: WorkerId; generation: number }
  | { kind: 'spawn-authority-rotated'; worker: WorkerId; from: number; to: number }
  | { kind: 'delegation-discharged'; id: DelegationId }
  | { kind: 'delegation-cancelled'; id: DelegationId };

interface WorkerProjection {
  generation: number;
  active: boolean;
  spawn_authority: boolean;
}

interface DelegationProjection {
  parent: WorkerId;
  parent_generation: number;
  child: WorkerId;
  semantic_work: string;
  state: 'reserved' | 'in-flight' | 'delivered' | 'discharged' | 'cancelled';
}

interface Projection {
  workers: Map<WorkerId, WorkerProjection>;
  delegations: Map<DelegationId, DelegationProjection>;
}

function project(facts: readonly Fact[]): Projection {
  const workers = new Map<WorkerId, WorkerProjection>();
  const delegations = new Map<DelegationId, DelegationProjection>();

  for (const fact of facts) {
    switch (fact.kind) {
      case 'worker-start': {
        workers.set(fact.worker, {
          generation: fact.generation,
          active: true,
          spawn_authority: true,
        });
        break;
      }
      case 'delegation-reserved': {
        const parent = workers.get(fact.parent);
        if (
          !parent ||
          !parent.active ||
          !parent.spawn_authority ||
          parent.generation !== fact.parent_generation
        ) {
          throw new Error('STALE_SPAWN_AUTHORITY');
        }
        if (!delegations.has(fact.id)) {
          delegations.set(fact.id, {
            parent: fact.parent,
            parent_generation: fact.parent_generation,
            child: fact.child,
            semantic_work: fact.semantic_work,
            state: 'reserved',
          });
        }
        break;
      }
      case 'delegation-dispatched': {
        const delegation = delegations.get(fact.id);
        if (!delegation) throw new Error('UNKNOWN_DELEGATION');
        if (delegation.state === 'reserved') delegation.state = 'in-flight';
        break;
      }
      case 'delegation-delivered': {
        const delegation = delegations.get(fact.id);
        if (!delegation) throw new Error('UNKNOWN_DELEGATION');
        if (delegation.state === 'in-flight') delegation.state = 'delivered';
        if (!workers.has(delegation.child)) {
          workers.set(delegation.child, {
            generation: 1,
            active: true,
            spawn_authority: true,
          });
        }
        break;
      }
      case 'worker-finished': {
        const worker = workers.get(fact.worker);
        if (!worker || worker.generation !== fact.generation) {
          throw new Error('STALE_WORKER_FINISH');
        }
        worker.active = false;
        worker.spawn_authority = false;
        break;
      }
      case 'spawn-authority-rotated': {
        const worker = workers.get(fact.worker);
        if (!worker || worker.generation !== fact.from) {
          throw new Error('STALE_SPAWN_ROTATION');
        }
        worker.generation = fact.to;
        worker.spawn_authority = true;
        break;
      }
      case 'delegation-discharged': {
        const delegation = delegations.get(fact.id);
        if (!delegation) throw new Error('UNKNOWN_DELEGATION');
        if (delegation.state !== 'cancelled') delegation.state = 'discharged';
        break;
      }
      case 'delegation-cancelled': {
        const delegation = delegations.get(fact.id);
        if (!delegation) throw new Error('UNKNOWN_DELEGATION');
        if (delegation.state === 'in-flight' || delegation.state === 'delivered') {
          throw new Error('DELEGATION_MAY_HAVE_DISPATCHED');
        }
        delegation.state = 'cancelled';
        break;
      }
    }
  }

  return { workers, delegations };
}

function activeWorkers(projection: Projection): number {
  return [...projection.workers.values()].filter((worker) => worker.active).length;
}

function liveSpawnAuthorities(projection: Projection): number {
  return [...projection.workers.values()].filter((worker) => worker.spawn_authority).length;
}

function outstandingDelegations(projection: Projection): number {
  return [...projection.delegations.values()].filter(
    (delegation) => delegation.state !== 'discharged' && delegation.state !== 'cancelled',
  ).length;
}

function inFlightDelegations(projection: Projection): number {
  return [...projection.delegations.values()].filter(
    (delegation) => delegation.state === 'in-flight',
  ).length;
}

function naiveComplete(projection: Projection): boolean {
  return activeWorkers(projection) === 0;
}

function durablyComplete(projection: Projection): boolean {
  return (
    activeWorkers(projection) === 0 &&
    liveSpawnAuthorities(projection) === 0 &&
    outstandingDelegations(projection) === 0 &&
    inFlightDelegations(projection) === 0
  );
}

function snapshot(projection: Projection) {
  return {
    workers: [...projection.workers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    delegations: [...projection.delegations.entries()].sort(([a], [b]) => a.localeCompare(b)),
    active_workers: activeWorkers(projection),
    live_spawn_authorities: liveSpawnAuthorities(projection),
    outstanding_delegations: outstandingDelegations(projection),
    in_flight_delegations: inFlightDelegations(projection),
    complete: durablyComplete(projection),
  };
}

function append(facts: Fact[], fact: Fact): Projection {
  const candidate = [...facts, fact];
  const next = project(candidate);
  facts.push(fact);
  return next;
}

function expectAppendFailure(facts: readonly Fact[], fact: Fact, message: string): void {
  assert.throws(() => project([...facts, fact]), new RegExp(message));
}

function delayedChildCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  append(facts, {
    kind: 'delegation-reserved',
    id: 'd1',
    parent: 'root',
    parent_generation: 1,
    child: 'child',
    semantic_work: 'work:B',
  });
  append(facts, { kind: 'delegation-dispatched', id: 'd1' });
  const quiet = append(facts, { kind: 'worker-finished', worker: 'root', generation: 1 });

  assert.equal(activeWorkers(quiet), 0);
  assert.equal(naiveComplete(quiet), true);
  assert.equal(durablyComplete(quiet), false);
  assert.equal(inFlightDelegations(quiet), 1);

  append(facts, { kind: 'delegation-delivered', id: 'd1' });
  append(facts, { kind: 'worker-finished', worker: 'child', generation: 1 });
  const done = append(facts, { kind: 'delegation-discharged', id: 'd1' });
  assert.equal(durablyComplete(done), true);

  return { false_quiescence_detected: true, facts: facts.length };
}

function recursiveFanoutCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  for (const [id, child] of [
    ['d-a', 'a'],
    ['d-b', 'b'],
  ] as const) {
    append(facts, {
      kind: 'delegation-reserved',
      id,
      parent: 'root',
      parent_generation: 1,
      child,
      semantic_work: 'work:' + child,
    });
    append(facts, { kind: 'delegation-dispatched', id });
    append(facts, { kind: 'delegation-delivered', id });
  }
  append(facts, {
    kind: 'delegation-reserved',
    id: 'd-c',
    parent: 'a',
    parent_generation: 1,
    child: 'c',
    semantic_work: 'work:c',
  });
  append(facts, { kind: 'delegation-dispatched', id: 'd-c' });
  append(facts, { kind: 'worker-finished', worker: 'root', generation: 1 });
  append(facts, { kind: 'worker-finished', worker: 'a', generation: 1 });
  append(facts, { kind: 'delegation-discharged', id: 'd-a' });
  append(facts, { kind: 'worker-finished', worker: 'b', generation: 1 });
  append(facts, { kind: 'delegation-discharged', id: 'd-b' });

  const waitingOnGrandchild = project(facts);
  assert.equal(activeWorkers(waitingOnGrandchild), 0);
  assert.equal(durablyComplete(waitingOnGrandchild), false);

  append(facts, { kind: 'delegation-delivered', id: 'd-c' });
  append(facts, { kind: 'worker-finished', worker: 'c', generation: 1 });
  const done = append(facts, { kind: 'delegation-discharged', id: 'd-c' });
  assert.equal(durablyComplete(done), true);

  return { recursive_depth: 2, facts: facts.length };
}

function crashBeforeDispatchCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  append(facts, {
    kind: 'delegation-reserved',
    id: 'reserved-only',
    parent: 'root',
    parent_generation: 1,
    child: 'never-started',
    semantic_work: 'work:reserved-only',
  });
  const crashed = append(facts, { kind: 'worker-finished', worker: 'root', generation: 1 });
  assert.equal(naiveComplete(crashed), true);
  assert.equal(durablyComplete(crashed), false);

  const cancelled = append(facts, { kind: 'delegation-cancelled', id: 'reserved-only' });
  assert.equal(durablyComplete(cancelled), true);
  return { safe_cancel_required: true, facts: facts.length };
}

function crashAfterDispatchCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  append(facts, {
    kind: 'delegation-reserved',
    id: 'sent',
    parent: 'root',
    parent_generation: 1,
    child: 'child',
    semantic_work: 'work:sent',
  });
  append(facts, { kind: 'delegation-dispatched', id: 'sent' });
  const crashed = append(facts, { kind: 'worker-finished', worker: 'root', generation: 1 });
  assert.equal(naiveComplete(crashed), true);
  assert.equal(durablyComplete(crashed), false);
  expectAppendFailure(facts, { kind: 'delegation-cancelled', id: 'sent' }, 'DELEGATION_MAY_HAVE_DISPATCHED');

  append(facts, { kind: 'delegation-delivered', id: 'sent' });
  append(facts, { kind: 'worker-finished', worker: 'child', generation: 1 });
  const done = append(facts, { kind: 'delegation-discharged', id: 'sent' });
  assert.equal(durablyComplete(done), true);
  return { blind_cancel_rejected: true, facts: facts.length };
}

function duplicateDeliveryAndAckCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  append(facts, {
    kind: 'delegation-reserved',
    id: 'd',
    parent: 'root',
    parent_generation: 1,
    child: 'child',
    semantic_work: 'work:d',
  });
  append(facts, { kind: 'delegation-dispatched', id: 'd' });
  append(facts, { kind: 'delegation-delivered', id: 'd' });
  append(facts, { kind: 'delegation-delivered', id: 'd' });
  append(facts, { kind: 'worker-finished', worker: 'root', generation: 1 });
  append(facts, { kind: 'worker-finished', worker: 'child', generation: 1 });
  append(facts, { kind: 'delegation-discharged', id: 'd' });
  const duplicateAck = append(facts, { kind: 'delegation-discharged', id: 'd' });

  assert.equal(outstandingDelegations(duplicateAck), 0);
  assert.equal(durablyComplete(duplicateAck), true);
  return { idempotent_delivery: true, idempotent_ack: true, facts: facts.length };
}

function staleGenerationCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  append(facts, {
    kind: 'spawn-authority-rotated',
    worker: 'root',
    from: 1,
    to: 2,
  });
  expectAppendFailure(
    facts,
    {
      kind: 'delegation-reserved',
      id: 'stale',
      parent: 'root',
      parent_generation: 1,
      child: 'child',
      semantic_work: 'work:stale',
    },
    'STALE_SPAWN_AUTHORITY',
  );
  append(facts, {
    kind: 'delegation-reserved',
    id: 'current',
    parent: 'root',
    parent_generation: 2,
    child: 'child',
    semantic_work: 'work:current',
  });
  assert.equal(outstandingDelegations(project(facts)), 1);
  return { stale_generation_rejected: true, current_generation_admitted: true };
}

function convergentDiscoveryCase() {
  const facts: Fact[] = [{ kind: 'worker-start', worker: 'root', generation: 1 }];
  for (const id of ['left', 'right'] as const) {
    append(facts, {
      kind: 'delegation-reserved',
      id,
      parent: 'root',
      parent_generation: 1,
      child: 'shared',
      semantic_work: 'work:shared',
    });
    append(facts, { kind: 'delegation-dispatched', id });
    append(facts, { kind: 'delegation-delivered', id });
  }
  append(facts, { kind: 'worker-finished', worker: 'root', generation: 1 });
  append(facts, { kind: 'worker-finished', worker: 'shared', generation: 1 });

  const beforeAck = project(facts);
  assert.equal(activeWorkers(beforeAck), 0);
  assert.equal(outstandingDelegations(beforeAck), 2);

  const oneAck = append(facts, { kind: 'delegation-discharged', id: 'left' });
  assert.equal(outstandingDelegations(oneAck), 1);
  assert.equal(durablyComplete(oneAck), false);

  const bothAck = append(facts, { kind: 'delegation-discharged', id: 'right' });
  assert.equal(outstandingDelegations(bothAck), 0);
  assert.equal(durablyComplete(bothAck), true);
  return { semantic_children: 1, causal_delegations: 2 };
}

function replayCase() {
  const facts: Fact[] = [
    { kind: 'worker-start', worker: 'root', generation: 1 },
    {
      kind: 'delegation-reserved',
      id: 'replay',
      parent: 'root',
      parent_generation: 1,
      child: 'child',
      semantic_work: 'work:replay',
    },
    { kind: 'delegation-dispatched', id: 'replay' },
    { kind: 'worker-finished', worker: 'root', generation: 1 },
  ];
  const first = snapshot(project(facts));
  const reconstructed = snapshot(project(JSON.parse(JSON.stringify(facts)) as Fact[]));
  assert.deepEqual(reconstructed, first);
  assert.equal(reconstructed.complete, false);
  return { replay_equal: true, outstanding_delegations: reconstructed.outstanding_delegations };
}

const results = {
  delayed_child: delayedChildCase(),
  recursive_fanout: recursiveFanoutCase(),
  crash_before_dispatch: crashBeforeDispatchCase(),
  crash_after_dispatch: crashAfterDispatchCase(),
  duplicate_delivery_and_ack: duplicateDeliveryAndAckCase(),
  stale_generation: staleGenerationCase(),
  convergent_discovery: convergentDiscoveryCase(),
  replay: replayCase(),
};

console.log(JSON.stringify({ kind: 'diffusing-termination-results', ...results }));
console.log(
  JSON.stringify({
    kind: 'diffusing-termination-summary',
    naive_false_completion_witness: true,
    durable_accounting_rejects_false_completion: true,
    generation_fenced_spawn: true,
    replay_reconstructs_completion_projection: true,
  }),
);
