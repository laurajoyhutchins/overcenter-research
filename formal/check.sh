#!/usr/bin/env bash
set -euo pipefail

TLA_VERSION="1.7.4"
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORMAL="$ROOT/formal"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/overcenter-research/tla"
JAR="${TLA2TOOLS_JAR:-$CACHE_DIR/tla2tools-${TLA_VERSION}.jar}"

mkdir -p "$CACHE_DIR"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [[ ! -f "$JAR" ]]; then
  if [[ -n "${TLA2TOOLS_JAR:-}" ]]; then
    echo "TLA2TOOLS_JAR does not exist: $JAR" >&2
    exit 2
  fi
  curl -fsSL --retry 3 --retry-delay 2 \
    -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"
fi

actual_sha="$(sha256 "$JAR")"
if [[ "$actual_sha" != "$TLA_SHA256" ]]; then
  echo "unexpected tla2tools.jar sha256" >&2
  echo "expected: $TLA_SHA256" >&2
  echo "actual:   $actual_sha" >&2
  exit 2
fi

run_tlc() {
  local module="$1"
  local cfg="$2"
  local log="$3"
  (
    cd "$FORMAL"
    java -XX:+UseParallelGC -jar "$JAR" \
      -workers auto \
      -metadir "$FORMAL/.tlc/${module}-${cfg%.cfg}" \
      -config "$cfg" \
      "$module.tla"
  ) >"$log" 2>&1
}

rm -rf "$FORMAL/.tlc"
mkdir -p "$FORMAL/.tlc/logs"

check_good() {
  local module="$1"
  local cfg="$2"
  local label="$3"
  local log="$FORMAL/.tlc/logs/${cfg%.cfg}.log"

  echo "==> checking $label"
  if ! run_tlc "$module" "$cfg" "$log"; then
    cat "$log" >&2
    exit 1
  fi
  if ! grep -q "Model checking completed" "$log"; then
    cat "$log" >&2
    exit 1
  fi
  tail -n 8 "$log"
}

check_expected_failure() {
  local module="$1"
  local cfg="$2"
  local invariant="$3"
  local log="$FORMAL/.tlc/logs/${cfg%.cfg}.log"

  echo "==> checking expected counterexample: $cfg ($invariant)"
  if run_tlc "$module" "$cfg" "$log"; then
    echo "expected TLC to reject $cfg" >&2
    cat "$log" >&2
    exit 1
  fi
  if ! grep -q "Invariant ${invariant} is violated" "$log"; then
    echo "TLC failed for $cfg, but not with the expected invariant" >&2
    cat "$log" >&2
    exit 1
  fi
  grep -m1 "Invariant ${invariant} is violated" "$log"
}

check_expected_temporal_failure() {
  local module="$1"
  local cfg="$2"
  local log="$FORMAL/.tlc/logs/${cfg%.cfg}.log"

  echo "==> checking expected temporal counterexample: $cfg"
  if run_tlc "$module" "$cfg" "$log"; then
    echo "expected TLC to reject $cfg" >&2
    cat "$log" >&2
    exit 1
  fi
  if ! grep -Eq "Temporal propert(y|ies).*violated|Property.*violated" "$log"; then
    echo "TLC failed for $cfg, but not with the expected temporal-property violation" >&2
    cat "$log" >&2
    exit 1
  fi
  grep -Em1 "Temporal propert(y|ies).*violated|Property.*violated" "$log"
}

check_good "TransitionKernel" "TransitionKernel.cfg" "authoritative kernel"
check_expected_failure "TransitionKernel" "BrokenNoFence.cfg" "MutationAuthoritySafety"
check_expected_failure "TransitionKernel" "BrokenNoRevision.cfg" "ExactRevisionEvidence"
check_expected_failure "TransitionKernel" "BrokenNoReplayGuard.cfg" "ReplaySafety"
check_expected_failure "TransitionKernel" "BrokenNoReservation.cfg" "ReservationSafety"
check_expected_failure "TransitionKernel" "BrokenNoEvidence.cfg" "NoFalseDone"

check_good "ResourceContainment" "ResourceContainment.cfg" "resource containment protocol"
check_expected_failure "ResourceContainment" "BrokenResourceIdentity.cfg" "ExactLeafAuthority"
check_expected_failure "ResourceContainment" "BrokenResourceEarlyEvidence.cfg" "FinalEvidenceSafety"

check_good "AsyncEffectKernel" "AsyncEffectKernel.cfg" "asynchronous effect finality kernel"
check_expected_failure "AsyncEffectKernel" "BrokenAsyncNoTerminality.cfg" "NoDoubleExecution"
check_expected_failure "AsyncEffectKernel" "BrokenAsyncNoDeliveryDedupe.cfg" "NoDoubleExecution"
check_expected_failure "AsyncEffectKernel" "BrokenAsyncNoFence.cfg" "AuthoritySafety"

check_good "RecoveryLiveness" "RecoveryLiveness.cfg" "conditional recovery liveness"
check_expected_temporal_failure "RecoveryLiveness" "BrokenRecoveryNoReap.cfg"

check_good "SchedulerLiveness" "SchedulerLiveness.cfg" "conditional scheduler liveness"
check_expected_temporal_failure "SchedulerLiveness" "BrokenSchedulerUnfair.cfg"
check_expected_temporal_failure "SchedulerLiveness" "SchedulerFreshFlood.cfg"

check_good "SchedulerServiceAge" "SchedulerServiceAge.cfg" "service-age scheduler liveness"
check_expected_temporal_failure "SchedulerServiceAge" "BrokenServiceAgeNonMonotone.cfg"

echo "TLA+ safety and conditional-liveness models, including all negative controls, behaved as expected."
