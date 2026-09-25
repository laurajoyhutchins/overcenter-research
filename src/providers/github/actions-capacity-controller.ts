import { GitFactStore } from '../../storage/git-store.ts';

const STATE_SCHEMA = 'overcenter-github-actions-capacity/v1' as const;
const STATE_FILE = 'github-actions-capacity.json';
const DEFAULT_REF = 'refs/overcenter/github-actions-capacity';
const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HANDOFF_TTL_MS = 5 * 60 * 1000;

type ReservationPhase = 'reserved' | 'dispatched';

interface Reservation {
  id: string;
  capacity_cost: number;
  phase: ReservationPhase;
  expires_at_ms: number;
}

interface ReservationState {
  schema: typeof STATE_SCHEMA;
  budget: number;
  reservations: Reservation[];
}

interface ReservationStore {
  head(): string | null;
  read(head: string): unknown | null;
  append(expectedHead: string | null, state: ReservationState): string | null;
}

class GitReservationStore implements ReservationStore {
  readonly #store: GitFactStore;

  constructor(
    repo: string,
    {
      ref = DEFAULT_REF,
      remote = 'origin',
    }: {
      ref?: string;
      remote?: string | null;
    } = {},
  ) {
    this.#store = new GitFactStore(repo, { ref, remote });
  }

  head(): string | null {
    return this.#store.head();
  }

  read(head: string): unknown | null {
    return this.#store.readJson(head, STATE_FILE);
  }

  append(expectedHead: string | null, state: ReservationState): string | null {
    return this.#store.append(expectedHead, 'overcenter: update GitHub Actions capacity', {
      [STATE_FILE]: state,
    });
  }
}

function positiveInteger(value: unknown, code: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
}

function nonnegativeInteger(value: unknown, code: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
}

function validateReservation(value: unknown): Reservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
  }
  positiveInteger(raw.capacity_cost, 'GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
  if (raw.phase !== 'reserved' && raw.phase !== 'dispatched') {
    throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
  }
  nonnegativeInteger(raw.expires_at_ms, 'GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
  return {
    id: raw.id,
    capacity_cost: raw.capacity_cost,
    phase: raw.phase,
    expires_at_ms: raw.expires_at_ms,
  };
}

function state(value: unknown, budget: number): ReservationState {
  if (value == null) return { schema: STATE_SCHEMA, budget, reservations: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_STATE_INVALID');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== STATE_SCHEMA || raw.budget !== budget || !Array.isArray(raw.reservations)) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_STATE_INVALID');
  }
  const reservations = raw.reservations.map(validateReservation);
  if (new Set(reservations.map((reservation) => reservation.id)).size !== reservations.length) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_DUPLICATE');
  }
  return { schema: STATE_SCHEMA, budget, reservations };
}

function active(state: ReservationState, nowMs: number): Reservation[] {
  return state.reservations.filter((reservation) => reservation.expires_at_ms > nowMs);
}

function committedCapacity(reservations: readonly Reservation[]): number {
  return reservations.reduce((sum, reservation) => sum + reservation.capacity_cost, 0);
}

export interface GithubActionsCapacity {
  budget: number;
  committed_capacity: number;
  available_capacity: number;
}

export interface GithubActionsCapacityReservation {
  reservation_id: string;
  capacity_cost: number;
  phase: ReservationPhase;
  expires_at_ms: number;
  authority_head: string;
}

export interface GithubActionsDispatchContract {
  reservation_id: string;
  capacity_cost: number;
}

export type GithubActionsDispatchReservation =
  | {
      state: 'reserved';
      reservation: GithubActionsCapacityReservation;
      capacity: GithubActionsCapacity;
    }
  | {
      state: 'saturated';
      capacity: GithubActionsCapacity;
    };

export class GithubActionsCapacityController {
  readonly budget: number;
  readonly #reservationTtlMs: number;
  readonly #handoffTtlMs: number;
  readonly #clock: () => number;
  readonly #store: ReservationStore;

  constructor({
    budget,
    reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
    handoffTtlMs = DEFAULT_HANDOFF_TTL_MS,
    clock = () => Date.now(),
    store,
    repo,
    ref,
    remote,
  }: {
    budget: number;
    reservationTtlMs?: number;
    handoffTtlMs?: number;
    clock?: () => number;
    store?: ReservationStore;
    repo?: string;
    ref?: string;
    remote?: string | null;
  }) {
    positiveInteger(budget, 'GITHUB_ACTIONS_CAPACITY_BUDGET_INVALID');
    positiveInteger(reservationTtlMs, 'GITHUB_ACTIONS_CAPACITY_RESERVATION_TTL_INVALID');
    positiveInteger(handoffTtlMs, 'GITHUB_ACTIONS_CAPACITY_HANDOFF_TTL_INVALID');
    if (!store && !repo) throw new Error('GITHUB_ACTIONS_CAPACITY_AUTHORITY_REQUIRED');
    this.budget = budget;
    this.#reservationTtlMs = reservationTtlMs;
    this.#handoffTtlMs = handoffTtlMs;
    this.#clock = clock;
    this.#store = store ?? new GitReservationStore(repo!, { ref, remote });
  }

  capacity(): GithubActionsCapacity {
    const head = this.#store.head();
    const current = state(head ? this.#store.read(head) : null, this.budget);
    return this.#capacity(active(current, this.#clock()));
  }

  reservation(reservationId: string): GithubActionsCapacityReservation | null {
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');
    const head = this.#store.head();
    if (!head) return null;
    const current = state(this.#store.read(head), this.budget);
    const found = active(current, this.#clock()).find(
      (reservation) => reservation.id === reservationId,
    );
    return found ? this.#publicReservation(found, head) : null;
  }

  reserveDispatch(contract: GithubActionsDispatchContract): GithubActionsDispatchReservation {
    const reservationId = contract.reservation_id;
    const capacityCost = contract.capacity_cost;
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');
    positiveInteger(capacityCost, 'GITHUB_ACTIONS_CAPACITY_COST_INVALID');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const now = this.#clock();
      const head = this.#store.head();
      const current = state(head ? this.#store.read(head) : null, this.budget);
      const reservations = active(current, now);
      const existing = reservations.find((reservation) => reservation.id === reservationId);
      if (existing) {
        if (existing.capacity_cost !== capacityCost) {
          throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_CONFLICT');
        }
        return {
          state: 'reserved',
          reservation: this.#publicReservation(existing, head!),
          capacity: this.#capacity(reservations),
        };
      }

      const before = this.#capacity(reservations);
      if (before.available_capacity < capacityCost) {
        return { state: 'saturated', capacity: before };
      }

      const reservation: Reservation = {
        id: reservationId,
        capacity_cost: capacityCost,
        phase: 'reserved',
        expires_at_ms: now + this.#reservationTtlMs,
      };
      const next = {
        schema: STATE_SCHEMA,
        budget: this.budget,
        reservations: [...reservations, reservation],
      } satisfies ReservationState;
      const commit = this.#store.append(head, next);
      if (commit) {
        return {
          state: 'reserved',
          reservation: this.#publicReservation(reservation, commit),
          capacity: this.#capacity(next.reservations),
        };
      }
    }
    throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_CONTENTION_EXHAUSTED');
  }

  markDispatched(reservationId: string): GithubActionsCapacityReservation {
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const now = this.#clock();
      const head = this.#store.head();
      if (!head) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_MISSING');
      const current = state(this.#store.read(head), this.budget);
      const reservations = active(current, now);
      const index = reservations.findIndex((reservation) => reservation.id === reservationId);
      if (index < 0) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_MISSING');
      const existing = reservations[index]!;
      if (existing.phase === 'dispatched') return this.#publicReservation(existing, head);

      const dispatched: Reservation = {
        ...existing,
        phase: 'dispatched',
        expires_at_ms: now + this.#handoffTtlMs,
      };
      const nextReservations = [...reservations];
      nextReservations[index] = dispatched;
      const commit = this.#store.append(head, {
        schema: STATE_SCHEMA,
        budget: this.budget,
        reservations: nextReservations,
      });
      if (commit) return this.#publicReservation(dispatched, commit);
    }
    throw new Error('GITHUB_ACTIONS_CAPACITY_DISPATCH_CONTENTION_EXHAUSTED');
  }

  releaseDispatch(reservationId: string): string | null {
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const now = this.#clock();
      const head = this.#store.head();
      if (!head) return null;
      const current = state(this.#store.read(head), this.budget);
      const reservations = active(current, now);
      const nextReservations = reservations.filter(
        (reservation) => reservation.id !== reservationId,
      );
      if (
        nextReservations.length === reservations.length &&
        reservations.length === current.reservations.length
      ) {
        return head;
      }
      const commit = this.#store.append(head, {
        schema: STATE_SCHEMA,
        budget: this.budget,
        reservations: nextReservations,
      });
      if (commit) return commit;
    }
    throw new Error('GITHUB_ACTIONS_CAPACITY_RELEASE_CONTENTION_EXHAUSTED');
  }

  #capacity(reservations: readonly Reservation[]): GithubActionsCapacity {
    const committed = committedCapacity(reservations);
    return {
      budget: this.budget,
      committed_capacity: committed,
      available_capacity: Math.max(0, this.budget - committed),
    };
  }

  #publicReservation(
    reservation: Reservation,
    authorityHead: string,
  ): GithubActionsCapacityReservation {
    return {
      reservation_id: reservation.id,
      capacity_cost: reservation.capacity_cost,
      phase: reservation.phase,
      expires_at_ms: reservation.expires_at_ms,
      authority_head: authorityHead,
    };
  }
}

export type { ReservationStore as GithubActionsReservationStore };
