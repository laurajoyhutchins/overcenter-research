# Rust Landlock launcher experiment

## Question

Can a small Rust launcher make filesystem authority a **physical property of the worker process**, instead of merely exposing a safe API that the worker could ignore?

This is the stronger form of the task-specific executable idea.

The launcher uses Linux Landlock to create a filesystem sandbox, restricts itself, then starts an ordinary Node worker. Landlock restrictions are inherited by child processes, so the worker cannot recover ambient filesystem authority by bypassing the Rust API or spawning another executable.

Linux documents Landlock as an unprivileged, stackable security mechanism for restricting ambient filesystem and network rights. This experiment uses only filesystem restrictions.

## Policy

The launched worker receives:

- read/write authority to the materialized task root;
- read-only access to the host runtime paths needed to start Node;
- no handled filesystem rights to the sibling directory containing the hostile secret and write target.

The launcher clears the worker environment and adds back only a sandbox marker for the proof.

\`\`\`text
trusted launcher
      |
      +-- task root: read/write
      +-- runtime closure: read-only
      +-- everything else: denied for handled FS rights
      |
      v
landlock_restrict_self()
      |
      v
  ordinary Node worker
      |
      +-- direct outside read      -> EACCES/EPERM
      +-- direct outside write     -> EACCES/EPERM
      +-- spawn /bin/cat outside   -> still denied
\`\`\`

## Run

\`\`\`sh
bash experiments/rust-landlock-launcher/proof.sh
\`\`\`

## What this proves

If the host kernel supports the required Landlock ABI, the worker cannot simply ignore the Rust helper and regain filesystem access. The restriction is enforced by the kernel and inherited by descendants.

That is materially stronger than the API-only capability capsule.

## What this does not prove

- Network access is not restricted in this experiment.
- Open file descriptors acquired before sandboxing are outside this proof and must be sanitized by a production launcher.
- Landlock is Linux-specific.
- Runtime files deliberately allowed read-only are part of the worker's execution closure.
- Provider mutation authority still depends on not handing the worker ambient credentials.

The production implication is narrow: Rust is a plausible implementation language for a **small trusted launcher/broker substrate** where native kernel security primitives matter. This is not evidence that the Overcenter semantic core should move to Rust.
