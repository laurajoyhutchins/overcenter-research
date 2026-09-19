import {
  KernelCore,
  runCoreLoop,
  type KernelOptions,
} from './engine.ts';
import { SqliteFactStore } from '../storage/sqlite.ts';

export type { Receipt } from './engine.ts';
export type { KernelOptions } from './engine.ts';

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
