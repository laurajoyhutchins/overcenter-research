import { GitFactStore } from '../../storage/git-store.ts';
import {
  observeGithubAccountRepositories,
  observeGithubActionsLoad,
  projectGithubActionsCapacity,
  type GithubActionsCapacityProjection,
  type GithubActionsLoadObservation,
} from './actions-capacity.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

const STATE_SCHEMA = 'overcenter-github-actions-capacity/v1' as const;
const STATE_FILE = 'github-actions-capacity.json';
const DEFAULT_REF = 'refs/overcenter/github-actions-capacity';

interface Reservation {
  id: string;
  jobs: number;
}

interface ReservationState {
  schema: typeof STATE_SCHEMA;
  account_login: string;
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
    return this.#store.append(expectedHead, 'overcenter: reserve GitHub Actions capacity', {
      [STATE_FILE]: state,
    });
  }
}

function positiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function state(value: unknown, accountLogin: string): ReservationState {
  if (value == null) {
    return { schema: STATE_SCHEMA, account_login: accountLogin, reservations: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_STATE_INVALID');
  }
  const raw = value as {
    schema?: unknown;
    account_login?: unknown;
    reservations?: unknown;
  };
  if (
    raw.schema !== STATE_SCHEMA ||
    raw.account_login !== accountLogin ||
    !Array.isArray(raw.reservations)
  ) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_STATE_INVALID');
  }

  const seen = new Set<string>();
  const reservations = raw.reservations.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
    }
    const reservation = item as { id?: unknown; jobs?: unknown };
    if (
      typeof reservation.id !== 'string' ||
      reservation.id.length === 0 ||
      typeof reservation.jobs !== 'number'
    ) {
      throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
    }
    positiveInteger(reservation.jobs, 'GITHUB_ACTIONS_CAPACITY_RESERVATION_INVALID');
    if (seen.has(reservation.id)) {
      throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_DUPLICATE');
    }
    seen.add(reservation.id);
    return { id: reservation.id, jobs: reservation.jobs };
  });

  return { schema: STATE_SCHEMA, account_login: accountLogin, reservations };
}

function reservedJobs(value: ReservationState): number {
  return value.reservations.reduce((sum, reservation) => sum + reservation.jobs, 0);
}

export type GithubActionsDispatchReservation =
  | {
      state: 'reserved';
      reservation_id: string;
      jobs: number;
      authority_head: string;
      capacity: GithubActionsCapacityProjection;
    }
  | {
      state: 'saturated';
      capacity: GithubActionsCapacityProjection;
    };

export class GithubActionsCapacityController {
  readonly accountLogin: string;
  readonly #store: ReservationStore;

  constructor(
    accountLogin: string,
    {
      store,
      repo,
      ref,
      remote,
    }: {
      store?: ReservationStore;
      repo?: string;
      ref?: string;
      remote?: string | null;
    },
  ) {
    if (!accountLogin) throw new Error('GITHUB_ACTIONS_CAPACITY_ACCOUNT_REQUIRED');
    if (!store && !repo) throw new Error('GITHUB_ACTIONS_CAPACITY_AUTHORITY_REQUIRED');
    this.accountLogin = accountLogin;
    this.#store = store ?? new GitReservationStore(repo!, { ref, remote });
  }

  observe(
    token: string,
    {
      get = githubGet,
      clock = () => new Date().toISOString(),
    }: {
      get?: GithubJsonGet;
      clock?: () => string;
    } = {},
  ): GithubActionsLoadObservation {
    const inventory = observeGithubAccountRepositories(token, this.accountLogin, { get, clock });
    return observeGithubActionsLoad(token, { inventory, get, clock });
  }

  reserveDispatch({
    observation,
    reservationId,
    jobs,
    limit,
    safetyReserveJobs = 0,
  }: {
    observation: GithubActionsLoadObservation;
    reservationId: string;
    jobs: number;
    limit: number;
    safetyReserveJobs?: number;
  }): GithubActionsDispatchReservation {
    if (observation.inventory.account_login !== this.accountLogin) {
      throw new Error('GITHUB_ACTIONS_CAPACITY_OBSERVATION_ACCOUNT_MISMATCH');
    }
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');
    positiveInteger(jobs, 'GITHUB_ACTIONS_CAPACITY_RESERVATION_JOBS_INVALID');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#store.head();
      const current = state(head ? this.#store.read(head) : null, this.accountLogin);
      const existing = current.reservations.find((reservation) => reservation.id === reservationId);
      if (existing) {
        if (existing.jobs !== jobs) {
          throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_CONFLICT');
        }
        const capacity = projectGithubActionsCapacity({
          observation,
          limit,
          locallyReservedJobs: reservedJobs(current) - existing.jobs,
          safetyReserveJobs,
        });
        return {
          state: 'reserved',
          reservation_id: reservationId,
          jobs,
          authority_head: head!,
          capacity,
        };
      }

      const capacity = projectGithubActionsCapacity({
        observation,
        limit,
        locallyReservedJobs: reservedJobs(current),
        safetyReserveJobs,
      });
      if (capacity.available_jobs < jobs) return { state: 'saturated', capacity };

      const next: ReservationState = {
        ...current,
        reservations: [...current.reservations, { id: reservationId, jobs }],
      };
      const commit = this.#store.append(head, next);
      if (commit) {
        return {
          state: 'reserved',
          reservation_id: reservationId,
          jobs,
          authority_head: commit,
          capacity: {
            ...capacity,
            locally_reserved_jobs: capacity.locally_reserved_jobs + jobs,
            available_jobs: capacity.available_jobs - jobs,
            state: capacity.available_jobs - jobs > 0 ? 'available' : 'saturated',
          },
        };
      }
    }
    throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_CONTENTION_EXHAUSTED');
  }

  releaseDispatch(reservationId: string): string | null {
    if (!reservationId) throw new Error('GITHUB_ACTIONS_CAPACITY_RESERVATION_ID_REQUIRED');

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#store.head();
      if (!head) return null;
      const current = state(this.#store.read(head), this.accountLogin);
      if (!current.reservations.some((reservation) => reservation.id === reservationId)) {
        return head;
      }
      const next: ReservationState = {
        ...current,
        reservations: current.reservations.filter(
          (reservation) => reservation.id !== reservationId,
        ),
      };
      const commit = this.#store.append(head, next);
      if (commit) return commit;
    }
    throw new Error('GITHUB_ACTIONS_CAPACITY_RELEASE_CONTENTION_EXHAUSTED');
  }
}

export type { ReservationStore as GithubActionsReservationStore };
