# Rust capability-capsule experiment

## Question

Does Rust earn a place in Overcenter by providing a materially stronger task-local execution primitive than the TypeScript/Node default?

This experiment intentionally separates two claims.

1. **Compiled task specialization is useful defense in depth.** A generated native capsule can contain only the operations and task-root identity that a worker was given.
2. **The stronger result is filesystem confinement.** On Linux, a tiny Rust helper can invoke \`openat2(2)\` directly and bind lookup to an already-open task root with \`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS\`.

The experiment does **not** claim that Rust is an authorization boundary against a process that already possesses broad provider credentials. If the worker can obtain a GitHub token, cloud credential, or broker credential, it can ignore this executable and talk to the provider itself. Credential/process isolation remains the real mutation-authority boundary.

## Shape

\`\`\`text
trusted preparation
  materialize exact task root
  record root (device,inode)
  compile task id + root identity
             |
             v
      Rust task capsule
       describe | read
             |
             v
 open bound root directory
             |
             v
 openat2(dirfd, relative,
   BENEATH | NO_SYMLINKS | NO_MAGICLINKS)
\`\`\`

The binary has no generic command dispatcher and no write operation. At runtime it refuses:

- absolute paths,
- \`..\` and other non-normal components,
- symlink traversal,
- replacement of the task-root directory after compilation,
- attempts to retarget authority through environment variables,
- commands that were not compiled into the capsule.

## Plausible TypeScript baseline

The comparison is not a deliberately naive \`path.startsWith(root)\` implementation.

\`node-realpath-baseline.mjs\`:

1. canonicalizes the root,
2. canonicalizes the candidate,
3. verifies that the canonical candidate is beneath the root,
4. opens the final path with \`O_NOFOLLOW\`.

That still has a check/open gap. \`O_NOFOLLOW\` protects the final component but does not pin parent-directory traversal to the directory tree inspected by \`realpath()\`.

The proof pauses Node after preflight, renames an intermediate directory, replaces it with a symlink to an outside directory, then lets Node open the file. Node reads \`SECRET\` outside the authorized root.

The Rust path has no corresponding user-space check/open split. \`openat2\` resolves the relative path beneath the bound directory file descriptor in one kernel operation and refuses the escaped coordinate.

## Run

Linux x86-64 is deliberate because this no-dependency experiment invokes the \`openat2\` syscall directly.

\`\`\`sh
bash experiments/rust-capability-capsule/proof.sh
\`\`\`

Expected end state:

\`\`\`text
PASS
Node baseline observed: SECRET
Rust capsule: escaped path denied
\`\`\`

## Interpretation

A positive result would justify Rust for a **small trusted substrate**, especially materialization, workspace/file confinement, credential-holding brokers, and task-specific launchers.

It would not justify rewriting Overcenter's graph, projection, provider semantics, or ordinary orchestration code in Rust. Those layers should remain in the language that makes the semantics easiest to inspect unless a separate experiment demonstrates a concrete Rust advantage.

The production design should prefer a reusable generic Rust confinement primitive plus data-bound task authority over generating arbitrary Rust source for every task. Code generation is cheap, but multiplying trusted implementations is not.
