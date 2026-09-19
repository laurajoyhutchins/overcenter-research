#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

root="$tmp/task-root"
outside="$tmp/outside"
sync="$tmp/sync"
capsule="$tmp/capsule"

mkdir -p "$root/slot" "$outside" "$sync"
printf 'SAFE\n' > "$root/slot/file"
printf 'SECRET\n' > "$outside/file"

root_dev="$(stat -c %d "$root")"
root_ino="$(stat -c %i "$root")"

echo "== toolchain =="
rustc --version
node --version
uname -srmo

echo "== compile task-specific capsule =="
OVERCENTER_TASK_ID="demo-task-7" \
OVERCENTER_TASK_ROOT="$root" \
OVERCENTER_TASK_ROOT_DEV="$root_dev" \
OVERCENTER_TASK_ROOT_INO="$root_ino" \
  rustc --edition=2021 -D warnings "$here/task_capsule.rs" -o "$capsule"

echo "== authorized read succeeds =="
test "$("$capsule" read slot/file)" = "SAFE"

echo "== runtime environment cannot retarget compiled authority =="
test "$(OVERCENTER_TASK_ROOT="$outside" "$capsule" read slot/file)" = "SAFE"

echo "== command surface is closed =="
if "$capsule" write slot/file PWNED >"$tmp/write.out" 2>"$tmp/write.err"; then
  echo "unexpected write command success" >&2
  exit 1
fi
grep -q 'allowed commands: describe, read' "$tmp/write.err"

echo "== lexical escapes fail closed =="
for bad in '../outside/file' '/etc/passwd' './slot/file'; do
  if "$capsule" read "$bad" >"$tmp/bad.out" 2>"$tmp/bad.err"; then
    echo "unexpected escape success: $bad" >&2
    exit 1
  fi
done

echo "== symlink escape fails closed =="
ln -s "$outside" "$root/link"
if "$capsule" read link/file >"$tmp/link.out" 2>"$tmp/link.err"; then
  echo "unexpected symlink escape success" >&2
  exit 1
fi

echo "== bound root replacement fails closed =="
mv "$root" "$tmp/original-root"
mkdir -p "$root/slot"
printf 'IMPOSTOR\n' > "$root/slot/file"
if "$capsule" read slot/file >"$tmp/root-swap.out" 2>"$tmp/root-swap.err"; then
  echo "unexpected root replacement success" >&2
  exit 1
fi
grep -q 'task root identity changed' "$tmp/root-swap.err"
rm -rf "$root"
mv "$tmp/original-root" "$root"

echo "== pure Node realpath + O_NOFOLLOW baseline loses a parent-directory race =="
rm -f "$root/link"
rm -rf "$sync"
mkdir -p "$sync"

node "$here/node-realpath-baseline.mjs" "$root" slot/file "$sync" >"$tmp/node.out" 2>"$tmp/node.err" &
node_pid=$!

for _ in $(seq 1 500); do
  if [[ -f "$sync/checked" ]]; then
    break
  fi
  sleep 0.01
done
test -f "$sync/checked"

mv "$root/slot" "$root/slot-safe"
ln -s "$outside" "$root/slot"
touch "$sync/go"
wait "$node_pid"

test "$(cat "$tmp/node.out")" = "SECRET"

echo "== Rust openat2 lookup refuses the same escaped coordinate =="
if "$capsule" read slot/file >"$tmp/rust-race.out" 2>"$tmp/rust-race.err"; then
  echo "unexpected Rust escape success" >&2
  exit 1
fi

echo
echo "PASS"
echo "Node baseline observed: $(tr -d '\n' < "$tmp/node.out")"
echo "Rust capsule: escaped path denied"
