#!/usr/bin/env bash
# READ-ONLY finalization recovery for the ONE existing MPGR Swap Executor V2
# deployment (trusted pinned run 39294717599): the deploy step broadcast a
# successful CREATE, but the seal step died on a lagging public-RPC replica
# ("contract ... does not have any code"). This script NEVER deploys, NEVER
# broadcasts, and refuses to run with any deployer key in scope. It:
#   1. re-reads the source run's metadata via the GitHub API and refuses unless
#      that run is the trusted V2 workflow at the expected owner-pinned SHA,
#      its deploy step SUCCEEDED and its seal step FAILED;
#   2. downloads that run's artifact and validates the recorded CREATE tx and
#      contract address against the caller-provided expected values (exact,
#      case-insensitive equality - nothing is inferred, fabricated or re-derived
#      from anything other than the failed run's own recorded data + the chain);
#   3. restores ONLY the unsealed staging manifest and the broadcast
#      run-latest.json into the workspace;
#   4. delegates sealing to finalize-manifest.sh (bounded RPC polling, optional
#      independent second-RPC cross-checks, full on-chain pin re-reads, fail
#      closed on any disagreement or retry exhaustion).
# On any failure the evidence directory is preserved (no manifest sealed, no
# verification claimed) so the caller can upload it untouched.
#
# Usage: scripts/swap-deploy-v2/recover-finalize.sh <run-id> <expected-tx> <expected-executor> <rpc-url> [alt-rpc-url]
# Required env:
#   RECOVERY_EXPECTED_PIN  40-hex trusted commit the source run executed
# Optional env:
#   RECOVERY_EVIDENCE_DIR  evidence directory (default: recovery-evidence/, gitignored)
#   RECOVERY_REPO          owner/repo override (default: $GITHUB_REPOSITORY, else git remote origin)
#   GH_TOKEN               GitHub token for gh api / gh run download in CI
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

EVID="${RECOVERY_EVIDENCE_DIR:-recovery-evidence}"
mkdir -p "$EVID"
fail() {
  echo "RECOVERY FAIL: $1" >&2
  printf '%s\n' "RECOVERY FAIL: $1" >>"$EVID/failure.txt" 2>/dev/null || true
  exit 1
}
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Keyless guard: the recovery must be structurally incapable of broadcasting.
for v in BASE_MAINNET_DEPLOYER_PRIVATE_KEY PRIVATE_KEY; do
  if [ -n "${!v:-}" ]; then fail "$v must NOT be in scope: recovery is read-only and keyless"; fi
done

RUN_ID="${1:?usage: recover-finalize.sh <run-id> <expected-tx> <expected-executor> <rpc-url> [alt-rpc-url]}"
ETX="$(lc "${2:?missing expected tx}")"
EEXEC="$(lc "${3:?missing expected executor}")"
RPC="${4:?missing primary rpc url}"
ALT_RPC="${5:-${BASE_MAINNET_RPC_URL_ALT:-}}"
PIN="$(lc "${RECOVERY_EXPECTED_PIN:?RECOVERY_EXPECTED_PIN (trusted 40-hex commit the source run executed) required}")"
grep -Eq '^[0-9]+$' <<<"$RUN_ID" || fail "run id must be numeric (got '$RUN_ID')"
grep -Eq '^0x[0-9a-f]{64}$' <<<"$ETX" || fail "expected tx hash is not 0x+64hex (got '$ETX')"
grep -Eq '^0x[0-9a-f]{40}$' <<<"$EEXEC" || fail "expected executor is not 0x+40hex (got '$EEXEC')"
grep -Eq '^[0-9a-f]{40}$' <<<"$PIN" || fail "RECOVERY_EXPECTED_PIN must be a 40-hex commit SHA (got '$PIN')"
command -v gh >/dev/null 2>&1 || fail "gh CLI is required (run metadata + artifact download)"
command -v cast >/dev/null 2>&1 || fail "cast is required (read-only on-chain verification)"
command -v jq >/dev/null 2>&1 || fail "jq is required"

REPO="${RECOVERY_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$REPO" ]; then
  REPO="$(git remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]||; s|\.git$||')" || true
fi
[ -n "$REPO" ] || fail "cannot determine owner/repo (set GITHUB_REPOSITORY or RECOVERY_REPO)"

STAGING=deployments/base-mainnet/mpgr-swap-executor-v2.staging.json
FINAL=deployments/base-mainnet/mpgr-swap-executor-v2.json
GATE=deployments/base-mainnet/deploy-v2-config.json
RUN_JSON=broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json
ART_NAME=mpgr-swap-executor-v2-base-mainnet

# Workspace purity: exactly one source of truth (the artifact) may feed the seal.
[ ! -f "$FINAL" ] || fail "final manifest already exists in this workspace ($FINAL); refusing to reseal"
[ ! -f "$STAGING" ] || fail "workspace already contains a staging manifest ($STAGING); refusing to mix it with the artifact"
[ ! -f "$RUN_JSON" ] || fail "workspace already contains a broadcast artifact ($RUN_JSON); refusing to mix it with the downloaded one"
[ -f "$GATE" ] || fail "V2 gate config missing ($GATE)"

# 1. Source-run metadata: recovery is defined ONLY for the trusted V2 run whose
#    deploy succeeded and whose seal step failed at the expected pin.
RUN_META="$(gh api "repos/$REPO/actions/runs/$RUN_ID")" || fail "cannot read workflow run $RUN_ID via the GitHub API"
printf '%s\n' "$RUN_META" >"$EVID/source-run.json"
[ "$(jq -r '.path // empty' <<<"$RUN_META")" = ".github/workflows/deploy-swap-executor-v2-trusted.yml" ] \
  || fail "run $RUN_ID is not the trusted V2 deployment workflow (path '$(jq -r '.path // empty' <<<"$RUN_META")')"
[ "$(jq -r '.head_sha // empty' <<<"$RUN_META")" = "$PIN" ] \
  || fail "run $RUN_ID head_sha '$(jq -r '.head_sha // empty' <<<"$RUN_META")' != expected trusted pin $PIN"
[ "$(jq -r '.event // empty' <<<"$RUN_META")" = "workflow_dispatch" ] \
  || fail "run $RUN_ID was not a workflow_dispatch (event '$(jq -r '.event // empty' <<<"$RUN_META")')"
RUN_CONCLUSION="$(jq -r '.conclusion // empty' <<<"$RUN_META")"
[ "$RUN_CONCLUSION" = "failure" ] \
  || fail "run $RUN_ID conclusion is '$RUN_CONCLUSION'; recovery is only defined for the failed-seal run"
JOBS="$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs")" || fail "cannot read jobs of run $RUN_ID"
printf '%s\n' "$JOBS" >"$EVID/source-run-jobs.json"
DEPLOY_CONCLUSION="$(jq -r '[.jobs[] | select(.name == "deploy") | .steps[] | select(.name | startswith("Deploy (single broadcast")) | .conclusion][0] // empty' <<<"$JOBS")"
SEAL_CONCLUSION="$(jq -r '[.jobs[] | select(.name == "deploy") | .steps[] | select(.name | startswith("Seal manifest")) | .conclusion][0] // empty' <<<"$JOBS")"
[ "$DEPLOY_CONCLUSION" = "success" ] \
  || fail "the deploy step of run $RUN_ID did not succeed (conclusion '$DEPLOY_CONCLUSION'); there is no existing deployment to recover"
[ "$SEAL_CONCLUSION" = "failure" ] \
  || fail "the seal step of run $RUN_ID did not fail (conclusion '$SEAL_CONCLUSION'); this recovery is only for a failed seal"

# 2. Artifact download + integrity: the recorded CREATE must match the expected
#    tx/executor EXACTLY, and the staging manifest must still be unsealed.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gh run download "$RUN_ID" --repo "$REPO" -n "$ART_NAME" -D "$WORK/artifact" \
  || fail "cannot download artifact $ART_NAME from run $RUN_ID"
A_STAGE="$WORK/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json"
A_RUN="$WORK/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json"
[ -f "$A_STAGE" ] || fail "artifact of run $RUN_ID contains no staging manifest"
[ -f "$A_RUN" ] || fail "artifact of run $RUN_ID contains no broadcast run-latest.json"
cp "$A_STAGE" "$EVID/artifact-staging.json"
cp "$A_RUN" "$EVID/artifact-run-latest.json"

[ "$(jq -r '.manifestSchema // empty' "$A_STAGE")" = "mpgr-swap-executor/v2" ] || fail "artifact staging manifest has the wrong schema"
[ "$(jq -r '.chainId // empty' "$A_STAGE")" = "8453" ] || fail "artifact staging manifest chainId != 8453"
[ "$(lc "$(jq -r '.executor // empty' "$A_STAGE")")" = "$EEXEC" ] \
  || fail "artifact staging executor '$(jq -r '.executor // empty' "$A_STAGE")' != expected $EEXEC"
[ -z "$(jq -r '.deployTx // empty' "$A_STAGE")" ] || fail "artifact staging manifest is already sealed (deployTx present); nothing to recover"
[ "$(jq -r '.deployBlock // empty' "$A_STAGE")" = "0" ] || fail "artifact staging manifest is already sealed (deployBlock != 0)"
if grep -q 'pending-record' "$A_STAGE"; then fail "placeholder pending-record in the artifact staging manifest"; fi

CREATE_COUNT="$(jq -r '[.transactions[] | select(.transactionType == "CREATE")] | length' "$A_RUN")"
[ "$CREATE_COUNT" = "1" ] || fail "artifact broadcast records $CREATE_COUNT CREATE transactions; exactly 1 was authorized"
A_TX="$(jq -r --arg a "$EEXEC" \
  '[.transactions[] | select(.transactionType == "CREATE" and ((.contractAddress // "") | ascii_downcase) == $a) | .hash][0] // empty' "$A_RUN")"
[ -n "$A_TX" ] || fail "artifact broadcast has no CREATE for $EEXEC"
[ "$(lc "$A_TX")" = "$ETX" ] || fail "artifact CREATE tx '$A_TX' != expected $ETX; refusing to recover an unlisted deployment"

# 3. Restore ONLY the two recovery inputs into the workspace.
mkdir -p "$(dirname "$RUN_JSON")"
cp "$A_RUN" "$RUN_JSON"
cp "$A_STAGE" "$STAGING"
echo "recovery: restored the unsealed staging manifest + broadcast artifact of run $RUN_ID (tx $ETX, executor $EEXEC)"

# 4. Delegate sealing: bounded polling, optional second-RPC cross-checks, full
#    on-chain pin re-reads. No broadcast happens anywhere in this path.
export FINALIZE_EVIDENCE_FILE="$EVID/finalize-failures.txt"
if ! bash scripts/swap-deploy-v2/finalize-manifest.sh "$RPC" ${ALT_RPC:+"$ALT_RPC"}; then
  cp -f "$STAGING" "$EVID/unsealed-staging.json" 2>/dev/null || true
  fail "finalization failed against the recovered deployment data; evidence preserved in $EVID (no manifest sealed, no verification claimed)"
fi
cp -f "$FINAL" "$EVID/sealed-manifest.json"
cp -f "$GATE" "$EVID/deploy-v2-config.post-seal.json" 2>/dev/null || true
echo "RECOVERY PASS: sealed $FINAL from the existing run $RUN_ID deployment data; evidence in $EVID"
