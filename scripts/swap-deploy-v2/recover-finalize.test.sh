#!/usr/bin/env bash
# Offline regression suite for the READ-ONLY V2 finalization recovery
# (scripts/swap-deploy-v2/recover-finalize.sh) with stub `gh` + stub `cast`:
# no network, no key, no transaction. Proves the recovery refuses everything
# that is not exactly the failed trusted run's own recorded deployment, and
# that it seals only when the (stubbed) chain agrees on both endpoints.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/swap-deploy-v2/mocks/fixtures.sh
. "$HERE/mocks/fixtures.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home"
BIN="$WORK/bin"
install_mocks "$BIN"

PRIMARY_URL=http://primary.stub.invalid
ALT_URL=http://alt.stub.invalid
STUB_LOG="$WORK/gh-and-cast.log"
: >"$STUB_LOG"

RUN_ID=39294717599
PIN=da73b567cdb052ff2bc05456f0a73d9e37ca8299

CASE_REPO=""
STUB_DIR=""
OUT=""
RC=0
EXTRA_ENV=""

new_case() { # fresh repo + fixtures (workspace has NO staging/broadcast/manifest)
  local n="${1:-case}"
  local base="$WORK/$n-$(date +%s%N)"
  CASE_REPO="$base/repo"
  STUB_DIR="$base/stub"
  mkdir -p "$base"
  scaffold_repo "$CASE_REPO"
  seed_fixtures "$STUB_DIR"
  # The failed run's artifact tree (only these two files are read by recovery).
  mkdir -p "$STUB_DIR/artifact/deployments/base-mainnet" \
    "$STUB_DIR/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453"
  cp "$STUB_DIR/staging.json" "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json"
  cp "$STUB_DIR/run-latest.json" "$STUB_DIR/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json"
  write_run_meta
  write_jobs_meta
  EXTRA_ENV=""
  : >"$STUB_LOG"
}

write_run_meta() { # [workflow-path] [conclusion]
  jq -n --arg pin "$PIN" \
    --arg path "${1:-.github/workflows/deploy-swap-executor-v2-trusted.yml}" \
    --arg concl "${2:-failure}" \
    '{path: $path, head_sha: $pin, event: "workflow_dispatch", conclusion: $concl}' \
    >"$STUB_DIR/run.json"
}

write_jobs_meta() { # ${1 deploy conclusion}, ${2 seal conclusion}
  jq -n --arg d "${1:-success}" --arg s "${2:-failure}" \
    '{jobs: [{name: "deploy", steps: [
       {name: "Deploy (single broadcast, only after pin verification + human environment approval + preflight)", conclusion: $d},
       {name: "Seal manifest with the real tx receipt + on-chain pin re-reads", conclusion: $s}]}]}' \
    >"$STUB_DIR/jobs.json"
}

run_recover() {
  : >"$STUB_LOG"
  set +e
  OUT="$(cd "$CASE_REPO" && env -i PATH="$BIN:/usr/bin:/bin" HOME="$WORK/home" \
    STUB_DIR="$STUB_DIR" STUB_LOG="$STUB_LOG" \
    STUB_PRIMARY_URL="$PRIMARY_URL" STUB_ALT_URL="$ALT_URL" \
    GITHUB_REPOSITORY=munazir17/MPGR-HUB \
    RECOVERY_REPO=munazir17/MPGR-HUB \
    RECOVERY_EXPECTED_PIN="$PIN" \
    RECOVERY_EVIDENCE_DIR="$CASE_REPO/recovery-evidence" \
    FINALIZE_RPC_ATTEMPTS=3 \
    FINALIZE_RPC_BACKOFF_SECONDS=0 \
    FINALIZE_RPC_BACKOFF_CAP_SECONDS=0 \
    FINALIZE_CODE_WAIT_ATTEMPTS=4 \
    FINALIZE_CODE_WAIT_INTERVAL_SECONDS=0 \
    ${EXTRA_ENV} \
    bash scripts/swap-deploy-v2/recover-finalize.sh "$RUN_ID" "$FIX_TX" "$FIX_EXECUTOR" "$PRIMARY_URL" "$ALT_URL" 2>&1)"
  RC=$?
  set -e
}

FINAL_REL=deployments/base-mainnet/mpgr-swap-executor-v2.json
STAGING_REL=deployments/base-mainnet/mpgr-swap-executor-v2.staging.json
GATE_REL=deployments/base-mainnet/deploy-v2-config.json
EVID_REL=recovery-evidence

sealed() { [ -f "$CASE_REPO/$FINAL_REL" ]; }
gate_flipped() { [ "$(jq -r .consumed "$CASE_REPO/$GATE_REL")" = "true" ]; }

echo "# recovery happy path: existing deployment data only, no broadcast"
new_case happy
run_recover
check "recovery seals the manifest (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "reports RECOVERY PASS" "$(grep -q 'RECOVERY PASS: sealed' <<<"$OUT" && echo 0 || echo 1)"
check "sealed tx is the artifact's exact CREATE tx" "$([ "$(jq -r .deployTx "$CASE_REPO/$FINAL_REL")" = "$FIX_TX" ] && echo 0 || echo 1)"
check "sealed executor is the existing contract" "$(
  [ "$(jq -r '.executor | ascii_downcase' "$CASE_REPO/$FINAL_REL")" = "$(printf '%s' "$FIX_EXECUTOR" | tr 'A-Z' 'a-z')" ] && echo 0 || echo 1)"
check "seal is cross-checked on the independent second RPC" "$(jq -e '.verification.crossCheckedWithSecondRpc == true' "$CASE_REPO/$FINAL_REL" >/dev/null && echo 0 || echo 1)"
check "gate is consumed exactly once (no further V2 deploy possible)" "$(gate_flipped && echo 0 || echo 1)"
check "workspace staging input was consumed" "$([ ! -f "$CASE_REPO/$STAGING_REL" ] && echo 0 || echo 1)"
check "evidence keeps the failed run's metadata" "$([ -f "$CASE_REPO/$EVID_REL/source-run.json" ] && [ -f "$CASE_REPO/$EVID_REL/source-run-jobs.json" ] && echo 0 || echo 1)"
check "evidence keeps the downloaded artifact copies" "$(
  [ -f "$CASE_REPO/$EVID_REL/artifact-staging.json" ] && [ -f "$CASE_REPO/$EVID_REL/artifact-run-latest.json" ] && echo 0 || echo 1)"
check "evidence keeps the sealed manifest + post-seal gate" "$(
  [ -f "$CASE_REPO/$EVID_REL/sealed-manifest.json" ] && [ -f "$CASE_REPO/$EVID_REL/deploy-v2-config.post-seal.json" ] && echo 0 || echo 1)"
check "no broadcast-capable command was invoked (no cast send / forge script)" "$(
  ! grep -qE 'forge script|cast send|--broadcast|--private-key' "$STUB_LOG" && echo 0 || echo 1)"

echo "# keyless guard"
new_case keyless
EXTRA_ENV="BASE_MAINNET_DEPLOYER_PRIVATE_KEY=0xtest-not-a-real-key"
run_recover
check "refuses to run with a deployer key in scope" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "names the keyless requirement" "$(grep -q 'must NOT be in scope' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing when a key is present" "$(! sealed && echo 0 || echo 1)"

echo "# source-run identity guards"
new_case wrong_workflow
write_run_meta ".github/workflows/deploy-swap-executor-trusted.yml" "failure"
run_recover
check "refuses a run from another workflow" "$(grep -q 'is not the trusted V2 deployment workflow' <<<"$OUT" && echo 0 || echo 1)"

new_case wrong_pin
jq '.head_sha = "0000000000000000000000000000000000000000"' "$STUB_DIR/run.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/run.json"
run_recover
check "refuses a run at a different commit than the expected pin" "$(grep -q '!= expected trusted pin' <<<"$OUT" && echo 0 || echo 1)"

new_case run_success
write_run_meta "" "success"
run_recover
check "refuses a successful run (nothing to recover)" "$(grep -q "recovery is only defined for the failed-seal run" <<<"$OUT" && echo 0 || echo 1)"

new_case deploy_failed
write_jobs_meta "failure" "skipped"
run_recover
check "refuses when the deploy step did not succeed" "$(grep -q 'did not succeed' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing when the deploy step failed" "$(! sealed && echo 0 || echo 1)"

new_case seal_succeeded
write_jobs_meta "success" "success"
run_recover
check "refuses when the seal step already succeeded" "$(grep -q 'did not fail' <<<"$OUT" && echo 0 || echo 1)"

echo "# artifact integrity guards (never recover an unlisted deployment)"
new_case tx_mismatch
jq '.transactions[0].hash = "0x1111111111111111111111111111111111111111111111111111111111111111"' \
  "$STUB_DIR/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json" >"$STUB_DIR/r.json" \
  && mv "$STUB_DIR/r.json" "$STUB_DIR/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json"
run_recover
check "refuses an artifact CREATE tx != expected tx" "$(grep -q 'refusing to recover an unlisted deployment' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing on a tx mismatch" "$(! sealed && echo 0 || echo 1)"

new_case executor_mismatch
jq '.executor = "0x000000000000000000000000000000000000dEaD"' \
  "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json" >"$STUB_DIR/r.json" \
  && mv "$STUB_DIR/r.json" "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json"
run_recover
check "refuses an artifact executor != expected executor" "$(grep -q '!= expected' <<<"$OUT" && echo 0 || echo 1)"

new_case artifact_sealed
jq '.deployTx = "0xdead" | .deployBlock = 1' \
  "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json" >"$STUB_DIR/r.json" \
  && mv "$STUB_DIR/r.json" "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json"
run_recover
check "refuses an already-sealed artifact staging manifest" "$(grep -q 'already sealed' <<<"$OUT" && echo 0 || echo 1)"

new_case artifact_chaid
jq '.chainId = 84532' "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json" >"$STUB_DIR/r.json" \
  && mv "$STUB_DIR/r.json" "$STUB_DIR/artifact/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json"
run_recover
check "refuses an artifact staging manifest from another chain" "$(grep -q 'chainId != 8453' <<<"$OUT" && echo 0 || echo 1)"

new_case artifact_multi_create
jq '.transactions += [.transactions[0]]' \
  "$STUB_DIR/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json" >"$STUB_DIR/r.json" \
  && mv "$STUB_DIR/r.json" "$STUB_DIR/artifact/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json"
run_recover
check "refuses an artifact with more than one CREATE" "$(grep -q 'records 2 CREATE transactions' <<<"$OUT" && echo 0 || echo 1)"

echo "# workspace purity"
new_case workspace_sealed
cp "$STUB_DIR/staging.json" "$CASE_REPO/$FINAL_REL"
run_recover
check "refuses to reseal when a final manifest exists" "$(grep -q 'final manifest already exists' <<<"$OUT" && echo 0 || echo 1)"

new_case workspace_staging
cp "$STUB_DIR/staging.json" "$CASE_REPO/$STAGING_REL"
run_recover
check "refuses to mix a workspace staging manifest with the artifact" "$(grep -q 'refusing to mix' <<<"$OUT" && echo 0 || echo 1)"

echo "# finalize failure inside recovery preserves evidence and claims nothing"
new_case finalize_fails
printf '99\n' >"$STUB_DIR/code-empty-primary"
run_recover
check "recovery fails closed when finalize fails" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "reports 'no verification claimed'" "$(grep -q 'no manifest sealed, no verification claimed' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing" "$(! sealed && echo 0 || echo 1)"
check "preserves the unsealed staging manifest as evidence" "$([ -f "$CASE_REPO/$EVID_REL/unsealed-staging.json" ] && echo 0 || echo 1)"
check "preserves the finalize failure detail" "$([ -s "$CASE_REPO/$EVID_REL/finalize-failures.txt" ] && echo 0 || echo 1)"
check "writes the failure summary" "$(grep -q 'RECOVERY FAIL' "$CASE_REPO/$EVID_REL/failure.txt" && echo 0 || echo 1)"
check "gate stays unconsumed after a failed recovery" "$(! gate_flipped && echo 0 || echo 1)"

echo
echo "recover-finalize: $FIX_PASS passed, $FIX_FAIL failed"
[ "$FIX_FAIL" -eq 0 ]
