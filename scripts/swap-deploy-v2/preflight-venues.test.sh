#!/usr/bin/env bash
# Regression test for the V2 preflight router-factory identity loop.
# Runs the REAL scripts/swap-deploy-v2/preflight.sh inside a throwaway git repo with a
# stub `cast` (no RPC, no secrets, no transactions). Every factory read must succeed and
# match exactly; a revert or a mismatch on any of the four venue rows must fail closed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PREFLIGHT_SRC="${PREFLIGHT_SRC:-$HERE/preflight.sh}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Official expectations. Aerodrome Classic 0xcF77... exposes defaultFactory(), NOT factory().
ROWS_LC=(
  "0x2626664c2603336e57b271c5c0b26f421741e481|factory()(address)|0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
  "0x698cb2b6dd822994581fea6ea4fc755d1363a92f|factory()(address)|0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"
  "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24|factory()(address)|0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"
  "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43|defaultFactory()(address)|0x420DD381b31aEf6683db6B902084cB0FFECe40Da"
  "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43|factory()(address)|REVERT"
)
# Real chain behaviour: the Aerodrome router has no factory() selector, so that read reverts.
# Table is "router|getter|value"; anything not listed is treated as a revert (fail closed).
base_table() {
  printf '%s\n' "${ROWS_LC[@]:0:4}" "${ROWS_LC[4]}"
}

mk_table() { # $1 router_lc  $2 getter  $3 new value  -> table with one row overridden
  base_table | awk -F'|' -v r="$1" -v s="$2" -v v="$3" 'BEGIN{OFS="|"} $1==r && $2==s {$3=v} {print}'
}

# Minimal scaffolding: git root, gate config, safe-check stub, and a stub cast on PATH.
setup_repo() { # $1 table file
  local root="$WORK/repo"
  rm -rf "$root"; mkdir -p "$root/scripts/swap-deploy-v2" "$root/scripts/swap-deploy" "$root/deployments/base-mainnet" "$WORK/bin"
  git -C "$root" init -q
  cp "$PREFLIGHT_SRC" "$root/scripts/swap-deploy-v2/preflight.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "SAFE-CHECK PASS: stub owner verified for test"' > "$root/scripts/swap-deploy/safe-check.sh"
  cat > "$root/deployments/base-mainnet/deploy-v2-config.json" <<'JSON'
{ "chainId": 8453, "swapExecutorV2DeployEnabled": true, "consumed": false, "deployerNonce": 2 }
JSON
  cp "$1" "$WORK/table.txt"
  cat > "$WORK/bin/cast" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  chain-id) echo 8453 ;;
  wallet) echo 0x1111111111111111111111111111111111111111 ;;
  nonce) echo 2 ;;
  balance) echo 1000000000000000000 ;;
  gas-price) echo 1000000 ;;
  codesize) echo 1 ;;
  call)
    r=$(printf '%s' "$2" | tr 'A-Z' 'a-z')
    v=$(awk -F'|' -v r="$r" -v s="$3" '$1==r && $2==s {print $3; exit}' "$STUB_TABLE")
    if [ -z "$v" ] || [ "$v" = REVERT ]; then
      echo "Error: server returned an error response: error code 3: execution reverted" >&2
      exit 1
    fi
    echo "$v" ;;
  *) echo "stub cast: unexpected subcommand $1" >&2; exit 2 ;;
esac
STUB
  chmod +x "$WORK/bin/cast" "$root/scripts/swap-deploy/safe-check.sh"
}

run_preflight() { # sets RC and OUT
  local root="$WORK/repo"
  export STUB_TABLE="$WORK/table.txt" STUB_LOG="$WORK/cast.log"
  : > "$STUB_LOG"
  set +e
  OUT=$(cd "$root" && env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$WORK" \
        MPGR_SWAP_EXECUTOR_V2_DEPLOY_ENABLED=true \
        BASE_MAINNET_DEPLOYER_PRIVATE_KEY=0xtest-not-a-real-key \
        BASE_MAINNET_RPC_URL=http://stub.invalid \
        SWAP_EXECUTOR_OWNER=0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B \
        STUB_TABLE="$STUB_TABLE" STUB_LOG="$STUB_LOG" \
        bash scripts/swap-deploy-v2/preflight.sh 2>&1)
  RC=$?
  set -e
}

PASS=0; FAIL=0
check() { # $1 description, $2 condition exit status
  if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "ok   - $1"; else FAIL=$((FAIL+1)); echo "FAIL - $1"; echo "$OUT" | sed 's/^/       | /'; fi
}

# 1. Correct getters: all four rows pass, and the Aerodrome row uses defaultFactory() only.
base_table > "$WORK/t_ok.txt"; setup_repo "$WORK/t_ok.txt"; run_preflight
check "all four venues pass with correct getters (exit 0)" $([ "$RC" -eq 0 ] && echo 0 || echo 1)
check "output reports V2 preflight passed" $(grep -q 'V2 preflight passed' <<<"$OUT" && echo 0 || echo 1)
check "Aerodrome row reads defaultFactory()" $(grep -qi 'call 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 defaultFactory()(address)' "$STUB_LOG" && echo 0 || echo 1)
check "Aerodrome router is never asked for factory()" $(grep -qi 'call 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 factory()' "$STUB_LOG" && echo 1 || echo 0)

# 2. Each of the four venue rows fails closed on a revert (read failure, not a comparison).
for row in "0x2626664c2603336E57B271c5C0b26F421741e481|factory()(address)" \
           "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F|factory()(address)" \
           "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24|factory()(address)" \
           "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43|defaultFactory()(address)"; do
  router="${row%%|*}"; getter="${row#*|}"; rl=$(printf '%s' "$router" | tr 'A-Z' 'a-z')
  mk_table "$rl" "$getter" REVERT > "$WORK/t_rev.txt"; setup_repo "$WORK/t_rev.txt"; run_preflight
  check "revert on $router $getter fails closed" $([ "$RC" -ne 0 ] && echo 0 || echo 1)
  check "  revert message names router, getter and expected factory" $(grep -q "router factory read failed: router=$router getter=$getter expected=" <<<"$OUT" && echo 0 || echo 1)
  check "  no 'V2 preflight passed' after a failed read" $(grep -q 'V2 preflight passed' <<<"$OUT" && echo 1 || echo 0)
done

# 3. Each of the four venue rows fails closed on a wrong factory, reporting expected vs actual.
WRONG=0x000000000000000000000000000000000000dEaD
for row in "0x2626664c2603336E57B271c5C0b26F421741e481|factory()(address)" \
           "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F|factory()(address)" \
           "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24|factory()(address)" \
           "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43|defaultFactory()(address)"; do
  router="${row%%|*}"; getter="${row#*|}"; rl=$(printf '%s' "$router" | tr 'A-Z' 'a-z')
  mk_table "$rl" "$getter" "$WRONG" > "$WORK/t_mis.txt"; setup_repo "$WORK/t_mis.txt"; run_preflight
  check "wrong factory on $router fails closed" $([ "$RC" -ne 0 ] && echo 0 || echo 1)
  check "  mismatch message reports router, expected and actual" $(grep -q "router factory mismatch: router=$router getter=$getter expected=.* actual=$WRONG" <<<"$OUT" && echo 0 || echo 1)
done

echo "preflight-venues: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
