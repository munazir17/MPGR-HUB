# Swap implementation evidence

Scope of this directory: changes after baseline `4aa22fd3c354c7242dcd01b193e7a4e4c0c87237`, not all older cumulative PR113 work. See [full eleven-area report](../../PR113-DEX-UX-FEE-AUDIT.md).

## Reproduction before edits

`before/reproduction.txt`: four passing baseline real-controller cases (happy approval→swap, wallet rejection; 360×800 / 390×844). Passing reproduces the **old** behavior, not the new acceptance requirements. The four baseline PNGs include the old multi-step UI and terminal declined-request state.

## Final implementation

- `mobile-summary.txt`: **142 passed** (71 per size). Transport fixtures, no actual wallet/network execution/settlement.
- `unit-summary.txt`: **3,737 passed / 24 skipped**, zero unhandled errors, exit 0.
- `types-summary.txt`, `lint-summary.txt`: typecheck PASS; lint 0 errors / 61 warnings, not suppressed.
- `controller-traces/`: **72** method/path/status traces: 64 Swap, 8 Autonomy lifecycle cases, isolated API/wallet transport. These are not provider/mainnet receipts.
- `history-race-negative-control.txt`: temporarily removed only the session/snapshot correlation guard; the real-controller delayed-history test correctly detects a **false success** in a different review (expected exit 1). An EXIT trap restored the fixed source. `history-races-fixed.txt`: both hash-binding and review-session races pass at both sizes (4/4). The full 142-case run subsequently passes with the fixed source.
- `changed-files.txt`: exact per-task file manifest, including documentation/evidence. No credentials or full browser network traces retained.

## Before / after phone captures

Full-page captures preserve the test harness's explicit **Simulated flows — no real wallet, network execution or settlement** notice. Fixtures also render diagnostic state below product components; those diagnostic labels are not production UI. Prices/balances in these fixture captures are synthetic and not market claims.

| State | 360×800 | 390×844 |
| --- | --- | --- |
| Receive-first panels after reversal / fresh executable fixture quote | [360](after/direction-360.png) | [390](after/direction-390.png) |
| Imported contract validation / unsupported fee route state | [360](after/token-validation-360.png) | [390](after/token-validation-390.png) |
| Confirmed fixture receipt / separate transaction links | [360](after/success-360.png) | [390](after/success-390.png) |
| Receipt-backed session activity | [360](after/activity-360.png) | [390](after/activity-390.png) |

## Not evidence of live acceptance

No live wallet signature, approval, trade, fee transfer or production configuration write. No workflow dispatch. Local bundle attempt was blocked fetching Google Fonts; do not describe it as a local build pass. The existing automatic hosted Preview check publishes **separate** anonymous deployed-screen evidence and read-only Base fee configuration/historical transfer results; use that exact-head check/artifact and PR delivery comment to determine whether those live reads succeeded. Anonymous 401 quote/import responses are authorization evidence, not authenticated executable-quote or settlement acceptance.
