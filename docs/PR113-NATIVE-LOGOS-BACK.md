# PR113 — Native ETH, verified logos and Back navigation

Task baseline: `793c65a3087b5615b55d1045ab5b214d28e4ed72`, same existing PR113 branch. Two before-tests (360×800 and 390×844) reproduced WETH as the default receive asset, text glyphs instead of logos, and no Back control. Reproduction and screenshots: `docs/evidence/pr113-native-logos-back/before/`.

## Native asset identity

Only the Swap form's initial receive selection changes: USDC → native ETH. WETH remains independently selectable. Base Mainnet is **8453**; Base WETH remains **0x4200000000000000000000000000000000000006**. The native ETH sentinel is an API identity, not a token contract. The selector, selected-token metadata and quote costs label it as native, with no ERC-20 contract; native sentinels are not presented as pay/receive contract addresses.

The existing balance adapter calls native `getBalance` on 8453 for ETH; WETH uses its actual ERC-20 `balanceOf` and `decimals`. Existing Executor adapters map only native ETH legs to the canonical wrapped pool asset, set gross native transaction value / unwrap flags as appropriate, and skip native-input approvals. Arbitrary token routes are not forced through WETH. Those adapters, routing priority, slippage, fee calculations, allowance handling, wallet confirmation and transaction/receipt semantics are unchanged.

Tests retain the real server-side Executor/native-route regressions and separately exercise native and ERC-20 unsigned intents. A pre-existing simulated quote fixture incorrectly attached an ERC-20 allowance issue to native ETH input; it now mirrors production's `allowance: null` for native input. No production execution code was changed to satisfy that fixture.

## Official, identity-bound local artwork

`lib/swap/token-logos.json` records immutable source URLs, chain/kind/address bindings, dimensions and SHA-256 hashes. Assets are static local PNGs under `public/tokens/base/`; no runtime third-party image fetches or image-proxy configuration is required.

- Ethereum's canonical diamond artwork: pinned Trust Wallet native Ethereum asset, explicitly bound to Base's **native** ETH identity, not presented as an ERC-20 contract.
- Base WETH, Circle USDC and cbETH: exact Base contracts cross-checked against the pinned Uniswap Base token list, with corresponding pinned Trust Wallet asset-directory artwork.
- Uniswap source commit: `716f1807cfd5ceb178e09636ba8e977b622ca777`.
- Trust Wallet artwork commit: `c0df8990ccacc249690e539fcac2d3cd5fe3bd20`.

No logo is selected by symbol. Wrong-chain, unknown-contract, wrong-kind and unverified metadata fail to the same neutral icon. Token-supplied remote image URLs are never read. PNG signatures, bounded sizes and exact content hashes are tested. Failed image loads also show the neutral icon. Known artwork is locally cached at build time; the imported metadata module is reused without runtime metadata lookups.

All other supported tokens retain their names/symbols and exact contract identities. Where matching vetted artwork is not available in this local cache (including B20 stocks and several Coinbase wrapped assets), a consistent neutral fallback is deliberately shown. A stock/company logo is not invented or substituted for a token logo. Imported symbols remain explicitly unverified; duplicate symbols are distinguished by exact contract address in the selector and on the selected unverified asset. An official logo does not prove token safety, liquidity or an executable route.

## Back navigation

A 44×44 left-arrow control labelled **Go back** sits at the top-left near the heading. It calls the existing Next router's `back()` only with useful same-origin history. Navigation API entry metadata proves the prior URL where available; older browsers may use a same-origin referrer. Unknown/unreadable history, direct entry, external destinations, API/static internals and same-page/hash-only entries conservatively use `router.replace('/')`, the HUB dashboard. No global history monkey-patching, Agent-memory tracking, new wallet, or unrelated navigation refactor is introduced. Back is disabled during active wallet/transaction execution; modal focus and existing confirmation controls remain intact.

Tests cover mobile and desktop history traversal and direct entry, as well as safe older-browser/external/malformed history decisions. The existing automatically triggered read-only Preview verifier additionally checks actual Next-router menu → Swap → back behavior, direct entry in a fresh tab, native default and successfully loaded local logos. Its same-origin GET-only browser allowlist remains enforced; it does not sign in or broadcast.

## Validation and boundaries

Local final validation: **3,773 unit tests passed / 24 existing skips**, **147 focused unit tests passed**, TypeScript passed, and lint had **0 errors / 61 existing warnings**. The full browser run had **179 passed / 1 interrupted by a Vite document reload during a source edit**. The final frozen-source browser run passed **26/26**, including that exact duplicate-symbol case at both widths plus all new native/logo/Back cases. No timeouts or assertions were weakened. Final screenshots come from that frozen-source run. Detailed commands/results and superseded-run limitations: `docs/evidence/pr113-native-logos-back/validation.txt`.

The exact pushed SHA, changed files and automatic hosted status are recorded in the PR delivery comment. Browser/provider/wallet/receipt scenarios are isolated simulations, not physical-wallet or live settlement acceptance. Before/after evidence is under `docs/evidence/pr113-native-logos-back/`.

No live transactions, real wallet signatures, new Agent wallet, production settings/secrets/gate changes, provider-priority changes, Executor/contract changes, workflow dispatch or merge. PR113 stays open. Sandbox Google Fonts access may block a local Next build; an exact-SHA hosted build is reported separately rather than changing fonts/configuration to hide that restriction.
