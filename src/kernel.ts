import {
  KernelCore,
  runCoreLoop,
  type KernelOptions,
} from './kernel-core.ts';
import { SqliteFactStore } from './sqlite-store.ts';

export type { Receipt } from './kernel-core.ts';
export type { KernelOptions } from './kernel-core.ts';

export class OvercenterKernel extends KernelCore {
  readonly path:string;
  readonly #store:SqliteFactStore;

  constructor(
    path:string,
    options:KernelOptions={},
  ) {
    const store=new SqliteFactStore(path);
    super(store,options);
    this.path=path;
    this.#store=store;
  }

  close():void {
    this.#store.close();
  }
}

export { runCoreLoop };
