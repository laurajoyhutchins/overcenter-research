# Portable worker client

`overcenter` is the small native executable distributed with reasoning work packets.

It is intentionally **not** the Overcenter authority and **not** the Rust confinement launcher.

```text
project.advance
      |
      v
assignment.json + overcenter
      |
      v
controlled or foreign worker
      |
      v
candidate.json
      |
      v
project.submit
```

The client owns only packet-local mechanics:

- parse and validate the immutable assignment;
- verify every delivered file digest;
- materialize a fresh workspace;
- run the declared command with an explicit minimal environment;
- hash the declared output;
- emit candidate bytes bound to the exact assignment, run, and claimed revision.

It contains no project-selection, claim, provider-mutation, verification, settlement, or project-truth authority. Modifying or replacing the client cannot grant those capabilities because the authority side validates the returned candidate independently.

## Platform boundary

The currently admitted artifact is a statically linked Linux x86-64 executable. That is a packaging support boundary, not a trust boundary. The same protocol applies to workers whose sandbox Overcenter controls and workers whose ambient capabilities it does not control.

Additional OS/architecture binaries should implement the same packet contract rather than introducing a new worker API.

## Build and proof

```sh
src/execution/worker-client/build.sh .overcenter-build/overcenter
npm run proof:worker-client
```

The proof generates assignment bytes through the TypeScript authority-side implementation, executes them through the native Rust client, validates the returned candidate through the TypeScript validator, and exercises damaged-input negative controls.

`src/execution/confinement` remains a separate Linux confinement primitive. A controlled worker may run this client inside that confinement, but the client itself never assumes that confinement exists.
