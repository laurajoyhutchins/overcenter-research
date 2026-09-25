import { KernelCore, type KernelOptions } from './engine.ts';
import { runCoreLoop } from '../execution/core-loop.ts';
import { SqliteFactStore } from '../storage/sqlite.ts';

export type { Receipt } from './engine.ts';
export type {
  GraphPatchInput,
  GeneratedOutputValidator,
  GraphReconciliationResult,
  KernelOptions,
} from './engine.ts';

export class OvercenterKernel extends KernelCore {
  readonly path: string;
  readonly #store: SqliteFactStore;

  constructor(path: string, options: KernelOptions = {}) {
    const store = new SqliteFactStore(path);
    super(store, options);
    this.path = path;
    this.#store = store;
  }

  close(): void {
    this.#store.close();
  }
}

export { runCoreLoop };
