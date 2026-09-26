import { GitFactStore } from '../../storage/git-store.ts';

const STATE_SCHEMA = 'overcenter-github-actions-capacity/v1' as const;
const STATE_FILE = 'github-actions-capacity.json';
const DEFAULT_REF = 'refs/overcenter/github-actions-capacity';

type ReservationPhase = 'reserved' | 'dispatched';

interface Reservation {
  id: string;
  capacity_cost: number;
  phase: ReservationPhase;
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
  return { id: raw.id, capacity_cost: raw.capacity_cost, phase: raw.phase };
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
  readonly #store: ReservationStore;

  constructor({
    budget,
    store,
    repo,
    ref,
    remote,
  }: {
    budget: number;
    store?: ReservationStore;
    repo?: string;
    ref?: string;
    remote?: string | null;
  }) {
    positiveInteger(budget, 'GITHUB_ACTIONS_CAPACITY_BUDGET_INVALID');
    if (!store && !repo) throw new Error('GITHUB_ACTIONS_CAPACITY_AUTHORITY_REQUIRED');
    this.budget = budget;
    this.#store = store ?? new GitReservationStore(repo!, { ref, remote });
  }

  capacity(): GithubActionsCapacity {
    const head = this.#store.head();
    const current = state(head ? this.#store.read(head) : null, this.budget);
    return this.#capacity(current.reservations);
  }

  reservation(reservationId: string): GithubActionsCapacityReservation | null {
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');
    const head = this.#store.head();
    if (!head) return null;
    const current = state(this.#store.read(head), this.budget);
    const found = current.reservations.find((reservation) => reservation.id === reservationId);
    return found ? this.#publicReservation(found, head) : null;
  }

  reserveDispatch(contract: GithubActionsDispatchContract): GithubActionsDispatchReservation {
    const reservationId = contract.reservation_id;
    const capacityCost = contract.capacity_cost;
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');
    positiveInteger(capacityCost, 'GITHUB_ACTIONS_CAPACITY_COST_INVALID');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#store.head();
      const current = state(head ? this.#store.read(head) : null, this.budget);
      const existing = current.reservations.find(
        (reservation) => reservation.id === reservationId,
      );
      if (existing) {
        if (existing.capacity_cost !== capacityCost) {
          throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_CONFLICT');
        }
        return {
          state: 'reserved',
          reservation: this.#publicReservation(existing, head!),
          capacity: this.#capacity(current.reservations),
        };
      }

      const before = this.#capacity(current.reservations);
      if (before.available_capacity < capacityCost) {
        return { state: 'saturated', capacity: before };
      }

      const reservation: Reservation = {
        id: reservationId,
        capacity_cost: capacityCost,
        phase: 'reserved',
      };
      const next = {
        schema: STATE_SCHEMA,
        budget: this.budget,
        reservations: [...current.reservations, reservation],
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
      const head = this.#store.head();
      if (!head) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_MISSING');
      const current = state(this.#store.read(head), this.budget);
      const index = current.reservations.findIndex(
        (reservation) => reservation.id === reservationId,
      );
      if (index < 0) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_MISSING');
      const existing = current.reservations[index]!;
      if (existing.phase === 'dispatched') return this.#publicReservation(existing, head);

      const dispatched: Reservation = { ...existing, phase: 'dispatched' };
      const reservations = [...current.reservations];
      reservations[index] = dispatched;
      const commit = this.#store.append(head, {
        schema: STATE_SCHEMA,
        budget: this.budget,
        reservations,
      });
      if (commit) return this.#publicReservation(dispatched, commit);
    }
    throw new Error('GITHUB_ACTIONS_CAPACITY_DISPATCH_CONTENTION_EXHAUSTED');
  }

  cancelReservation(reservationId: string): string | null {
    return this.#remove(reservationId, 'reserved', 'GITHUB_ACTIONS_CAPACITY_ALREADY_DISPATCHED');
  }

  completeDispatch(reservationId: string): string | null {
    return this.#remove(reservationId, 'dispatched', 'GITHUB_ACTIONS_CAPACITY_NOT_DISPATCHED');
  }

  #remove(
    reservationId: string,
    requiredPhase: ReservationPhase,
    phaseError: string,
  ): string | null {
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#store.head();
      if (!head) return null;
      const current = state(this.#store.read(head), this.budget);
      const found = current.reservations.find((reservation) => reservation.id === reservationId);
      if (!found) return head;
      if (found.phase !== requiredPhase) throw new Error(phaseError);

      const commit = this.#store.append(head, {
        schema: STATE_SCHEMA,
        budget: this.budget,
        reservations: current.reservations.filter(
          (reservation) => reservation.id !== reservationId,
        ),
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
      authority_head: authorityHead,
    };
  }
}

export type { ReservationStore as GithubActionsReservationStore };
