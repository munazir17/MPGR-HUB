# Swap-only hardening evidence

These are **isolated browser fixtures exercising the actual Swap controllers**. They are not live wallet, provider, liquidity, signing, or settlement acceptance. The visible fake wallet/provider responses and addresses are test data, not secrets. No real transaction was signed or broadcast.

- `360/390-route-discovery.png`: exact-address duplicate-symbol import retained for discovery, neutral logo, no executable selection without an approved route. Literal hostile metadata renders as text, never HTML.
- `360/390-native-alias-rejection.png`: ETH/WETH same-underlying receive choice is disabled before any quote.
- `360/390-unknown-allowance.png`: unknown allowance blocks before any approval or swap prompt.
- `desktop-review.png`: 1280×900 pay-first review, one contextual fee row.
- Adjacent JSON files record the corresponding mocked API request paths, bodies and statuses. They do not record live quotes or signatures.

Viewport coverage: 360×800 and 390×844, plus 1280×900 desktop. Full-page screenshots can be taller than the viewport because the harness also mounts Agent fixture controls below Swap. Browser evidence asserts no horizontal overflow.

## Actual final validation

Local Node 22.22.3 (CI specifies Node 20); locked dependencies installed with `npm ci --no-audit --no-fund`. No dependency or lockfile change.

| Command / check | Actual result |
|---|---|
| `npm run lint` | PASS: 0 errors, 61 existing warnings; no suppression added |
| `npm run typecheck` | PASS, also after standard build generated its types |
| `npx vitest run --maxWorkers=1` | PASS: 297 files passed, 5 skipped; **3913 tests passed, 24 skipped** |
| Swap-focused real-builder API/policy/client/capability tests | Included in full suite; 59 API tests, 51 catalog capability tests, 13 strict client tests, existing and extended Swap regressions pass |
| `npm run build` | Initial normal build FAILED because Google Fonts is outside sandbox network allowlist |
| Standard Turbopack `npm run build`, with `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` pointing to a test-only local CSS/font HTTP fixture outside repo | PASS: compilation, TypeScript, 34 static pages, route generation including `/api/swap/quote`; no application configuration changed |
| Mobile Swap browser suite (`swap.spec.ts`, both mobile viewports) | **85/86 passed initially**; one mobile-390 swap-revert case timed out waiting for its quote during concurrent build/resource contention |
| Same swap-revert case, both viewports, sequential retry | **2/2 PASS**, original assertions/timeouts unchanged; do not describe initial run as clean 86/86 |
| Native/logo/navigation + desktop browser suite | **20/20 PASS** sequentially |
| `git diff --check` | PASS |

The browser runs together cover all 106 distinct Swap/native/desktop cases; this is not a claim of one clean 106-case invocation or of the unrelated full Agent browser suite being rerun. All existing Agent unit tests were left unchanged and pass in the complete unit run.

### Unsuccessful intermediate checks (not hidden)

- Browser launch initially lacked `libnspr4.so`. An npm-provided Chromium and its bundled libraries were installed outside the repo; no test assertions changed.
- A concurrent full unit invocation had 3845 passes / 1 AgentKit timeout / 24 skips. Another contended invocation was stopped. The final sequential complete run above passed without altering Agent tests or increasing timeouts.
- A file-URL font mock caused a Turbopack internal error. An alternative webpack build compiled, then failed on the **unchanged existing** optional `GET(request?: Request)` Agent tokens route's webpack-generated type constraint. That Agent source was not edited. The final standard Turbopack build passed using only a local HTTP font fixture.

Live chain permissions, metadata, liquidity and end-to-end wallet acceptance remain unverified in this sandbox. No contract, allowlist, owner action, production gate, deployed setting or wallet creation was changed.
