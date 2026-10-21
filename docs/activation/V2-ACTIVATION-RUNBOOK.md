# V2 activation runbook — the exact diff, and what must be true before applying it

**Status of this document: the activation below has NOT been applied.** `V2_DEPLOYMENT` in
`lib/swap/v2/discovery.ts` is still literally `null`, the app on this branch and on `main`
still cannot build, simulate, sign or send a V2 swap, and `/api/swap/v2/quote` still returns
`preview: true, executable: false, transaction: null`. The patch in
[`v2-activation.patch`](./v2-activation.patch) is committed **inert**: it is a file in the
repository, not a change to the code.

## Why the diff is a file and not an uncommitted edit

The instruction was to write the exact activation diff and leave it uncommitted. Leaving an
edit to the single constant that enables production V2 routing sitting in a dirty working
tree is the one form this should not take: it is invisible in review, it is swept up by any
`git add -A`, and it turns the repository's own invariant tests red for anyone who runs them
next. So the diff is committed as a patch file instead — reviewable, durable, applicable with
one command, and impossible to activate by accident. The working tree stays clean and
`V2_DEPLOYMENT` stays `null` until a human applies it in its own commit.

## Preconditions — all of these, in this order

1. **The canary ran and both receipts verified.** Run
   [`scripts/swap-v2-canary.test.ts`](../../scripts/swap-v2-canary.test.ts) armed, sign the two
   swaps in the operator's own wallet, and verify each receipt read-only:

   ```sh
   # posture + dormancy, read-only
   MPGR_V2_CANARY=1 npx vitest run scripts/swap-v2-canary.test.ts
   # build the two unsigned swaps for YOUR wallet and print the runbook (no key, no send)
   MPGR_V2_CANARY=1 CANARY=1 CANARY_WALLET=0xYourWallet npx vitest run scripts/swap-v2-canary.test.ts
   # after you have signed and broadcast each one in your own wallet
   MPGR_V2_CANARY=1 CANARY_VERIFY_TX=0xReceiptHash npx vitest run scripts/swap-v2-canary.test.ts
   ```

   Both receipts must show `status: success`, `to` equal to the sealed executor, exactly one
   `SwapExecuted` with `feeBps 25` and `feeAmount == grossAmountIn * 25 / 10000` to
   `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`, and a `SwapPathExecuted` whenever the route
   had more than one leg. **If a verification fails, stop. Do not broadcast a second time.**
2. **Record both transaction hashes** in the activation commit message. An activation whose
   evidence is "we ran a canary" is not auditable; the hashes are.
3. **The fork proof is green on the commit being activated**, and CI is green apart from the
   known `npm run audit:high` advisory gate.
4. **Nothing is being deployed.** The executor is sealed at
   `0x4be1154440b26145d76608D41d403a33e76b9d0A` (deploy tx
   `0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b`, block 52820895) and
   its one-shot deployment gate is **consumed**. Activation reads that deployment; it never
   recreates it. `swapExecutorV2DeployEnabled` stays closed, no ownership, fee, pause or venue
   registration changes, and V1's `0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E` and its own gate
   are not touched. Pancake V3 and 0x Settler stay disabled.

## What the patch changes

Nine files. **One** of them is behaviour; the other eight are assertions that were written to
pin the dormant state and would otherwise fail — legitimately — the moment the gate flips.

| File | Change |
| --- | --- |
| `lib/swap/v2/discovery.ts` | **The activation.** `V2_DEPLOYMENT` becomes `SWAP_V2_SEALED_MANIFEST`, imported from `./sealed-manifest` |
| `lib/swap/v2/discovery.test.ts` | "has no activated deployment" → "has the sealed deployment active" |
| `lib/swap/v2/__tests__/deployment.test.ts` | the DORMANT gate test → ACTIVE, plus a new test that dormancy is still reachable through the injection hook, so the rollback shape stays covered |
| `lib/swap/v2/__tests__/wiring.test.ts` | the dormant-wiring block injects dormancy explicitly instead of inheriting it from the constant |
| `app/api/swap/v2/quote/route.test.ts` | same: the dormant HTTP boundary contract is injected, because that contract is what rollback restores |
| `app/api/swap/v2/quote/route.activation.test.ts` | same, and the test is renamed to say what it now proves |
| `app/api/swap/v2/settlement/route.test.ts` | same for the settlement route's `V2_NOT_ACTIVATED` gate |
| `scripts/swap-v2-finalize-recovery.test.ts` | the verbatim-literal assertion follows the new literal |
| `scripts/swap-v2-canary.test.ts` | the canary reports that activation has happened and is therefore retired |

Nothing else changes. No contract, no V1 code path, no dependency, no workflow, no secret.

The import comes from `lib/swap/v2/sealed-manifest.ts` rather than `./deployment` on purpose.
`deployment.ts` owns the gate and so imports `V2_DEPLOYMENT` from `discovery.ts`; pointing
`discovery.ts` back at `deployment.ts` creates a cycle that evaluates cleanly when
`discovery.ts` is reached first and fails when `deployment.ts` is reached first — whether the
activated app booted would depend on import order elsewhere in the graph. The manifest module
depends on neither, so the flip cannot fail that way.

## Applying it

```sh
git apply --check docs/activation/v2-activation.patch   # must print nothing
git apply docs/activation/v2-activation.patch
npm run check                                           # lint + typecheck + full suite
```

Verified before this document was written: with the patch applied, the full suite is **4692
passed / 32 skipped across 348 files**, `tsc --noEmit` is clean and `eslint .` reports 0
errors. That run is the reason this is a runbook rather than a guess.

Commit it as its own commit, with both canary receipt hashes in the message, and review it
there. Do not fold it into unrelated work.

## Rollback

Revert the one expression:

```ts
export const V2_DEPLOYMENT = null;
```

That is the whole rollback. V1 was never modified, so it needs none; no contract action is
required or permitted; and the eight assertion files revert with the same commit, restoring the
dormant expectations they were written for.
