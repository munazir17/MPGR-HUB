# Swap capability audit — Base 8453

Date: 2026-10-17. Scope: approved assisted Executor only; source/committed deployment evidence, **not fresh chain or liquidity proof**. No RPC host is reachable through this sandbox's network allowlist. No signed transaction or live trade was made.

## Classification and authorization boundary

- 48 catalog assets: 13 have at least one registered counterasset; 35 have none. 24 directed catalog combinations have registered routes (12 unordered including native ETH alias); all other catalog combinations are blocked. This is registration eligibility, not current execution readiness.
- 14 registered pool routes: USDC↔WETH plus 13 USDC↔B20; 3 registered B20 contracts are marked not-live by the catalog and remain excluded from Swap discovery. Offline API tests cover all 28 registered directions and 2 native alias directions.
- Every eligible request now independently checks Base chain ID, current token allowlist and router kind, live metadata/registered decimals, paused/fee configuration, positive post-fee pool quote, exact 25bps gross-sell fee/calldata/minimum and expiry. Current live outcomes remain **unverified** here. A successful quote is not settlement.
- No asset is classified as lacking liquidity or invalid solely because registration is missing. No new contract's metadata, compatibility, allowlisting or pool liquidity was freshly verified.
- Missing registration is code-only **only after** read-only proof of existing deployed permissions, exact decimals, approved router kind and compatible liquid single pool. Missing permissions require separately authorized owner changes. No allowlist/contract/registry changes were made. Multihop or other calldata architecture requires separate approval; provider fallback and separate fee transfers are forbidden.

## Exact contract inventory

“Registered” means eligible against the listed counterassets in both directions, subject to live checks. “Registration required” means no approved Swap route; external liquidity and current permissions are unknown. Decimals below are catalog/registry values, not fresh chain observations. All ERC-20 decimals are re-read before quoting; native ETH never calls ERC-20 methods.

| Asset | Exact Base contract / native identity | Catalog decimals | Registered decimals | Discovery / blocker | Registered counterassets |
|---|---|---:|---:|---|---|
| ETH | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (sentinel, NOT an ERC-20) | 18 | 18 | Registered; live checks required | USDC |
| WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | Registered; live checks required | USDC |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | 6 | Registered; live checks required | WETH, ETH, AAPLc, AMZNc, COINc, CRCLc, GOOGLc, INTCc, METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc |
| MPGR | `0xB2000000000000000000008d204203177a78AF01` | 18 | — | Registration required; discovery only, disabled | — |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` | 8 | 8 | Registered; live checks required | USDC |
| AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` | 8 | 8 | Registered; live checks required | USDC |
| COINc | `0xb200000000000000000000c85a31389D71F3ecfb` | 8 | 8 | Not-live catalog entry; excluded | USDC |
| CRCLc | `0xB20000000000000000000019f6E7C675b73C2e4D` | 8 | 8 | Not-live catalog entry; excluded | USDC |
| GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` | 8 | 8 | Registered; live checks required | USDC |
| INTCc | `0xB2000000000000000000004AFF16039bA04bdFBc` | 8 | 8 | Not-live catalog entry; excluded | USDC |
| METAc | `0xb2000000000000000000008bC8786B856E61707C` | 8 | 8 | Registered; live checks required | USDC |
| MSFTc | `0xb200000000000000000000Ab99cFa739E253872B` | 8 | 8 | Registered; live checks required | USDC |
| MSTRc | `0xb2000000000000000000004884b426556b92883d` | 8 | 8 | Registered; live checks required | USDC |
| NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` | 8 | 8 | Registered; live checks required | USDC |
| SNDKc | `0xb200000000000000000000397293Cb8cda9a10c5` | 8 | 8 | Registered; live checks required | USDC |
| SPCXc | `0xb2000000000000000000007b9fcbd005511aCBd5` | 8 | 8 | Registered; live checks required | USDC |
| TSLAc | `0xb2000000000000000000001e800a7f5189430cD0` | 8 | 8 | Registered; live checks required | USDC |
| AMDc | `0xB2000000000000000000000d8ce462E99ee7A47B` | 8 | — | Registration required; discovery only, disabled | — |
| ASTSc | `0xB200000000000000000000B1a29cF17A1819288a` | 8 | — | Registration required; discovery only, disabled | — |
| AVGOc | `0xB200000000000000000000Fc737aeA6196aB5a4c` | 8 | — | Registration required; discovery only, disabled | — |
| BEc | `0xb20000000000000000000016f9dfe862feBA122b` | 8 | — | Registration required; discovery only, disabled | — |
| CAKEc | `0xb200000000000000000000f215e4c890cfb7176b` | 8 | — | Registration required; discovery only, disabled | — |
| DJTc | `0xb200000000000000000000428E3a3eebBb20692B` | 8 | — | Registration required; discovery only, disabled | — |
| DUOLc | `0xb200000000000000000000a613d12deafbbb1db7` | 8 | — | Registration required; discovery only, disabled | — |
| GMEc | `0xb2000000000000000000007790ed6E48e06eD935` | 8 | — | Registration required; discovery only, disabled | — |
| HIMSc | `0xB20000000000000000000043a599976181Bcf336` | 8 | — | Registration required; discovery only, disabled | — |
| HTZc | `0xb2000000000000000000002601C5C94F435da168` | 8 | — | Registration required; discovery only, disabled | — |
| LLYc | `0xB200000000000000000000f1a0F91e34892E4718` | 8 | — | Registration required; discovery only, disabled | — |
| MRNAc | `0xB200000000000000000000e215e9B76ecBA02468` | 8 | — | Registration required; discovery only, disabled | — |
| MRVLc | `0xB200000000000000000000eC3c4c7395Cc609813` | 8 | — | Registration required; discovery only, disabled | — |
| MUc | `0xb200000000000000000000Fd2f87532B90095211` | 8 | — | Registration required; discovery only, disabled | — |
| NFLXc | `0xb20000000000000000000058B8c947e44011dFE6` | 8 | — | Registration required; discovery only, disabled | — |
| NVAXc | `0xb200000000000000000000c597c476fcf9aed3a8` | 8 | — | Registration required; discovery only, disabled | — |
| ORCLc | `0xb200000000000000000000347AFbA223D7B6b63C` | 8 | — | Registration required; discovery only, disabled | — |
| PFEc | `0xb20000000000000000000018fe7ec7d6dfeeb528` | 8 | — | Registration required; discovery only, disabled | — |
| PLTRc | `0xb2000000000000000000007d16372840dF4dAbbe` | 8 | — | Registration required; discovery only, disabled | — |
| PMc | `0xb2000000000000000000008fc2a8c23cf5937b66` | 8 | — | Registration required; discovery only, disabled | — |
| PTONc | `0xb2000000000000000000009272a491812842aa84` | 8 | — | Registration required; discovery only, disabled | — |
| PYPLc | `0xb200000000000000000000450ad3abe5d4846c6e` | 8 | — | Registration required; discovery only, disabled | — |
| QUBTc | `0xb200000000000000000000CA425ab42e07C35bC3` | 8 | — | Registration required; discovery only, disabled | — |
| RBLXc | `0xB2000000000000000000005bd7AE89b9E6189Bb5` | 8 | — | Registration required; discovery only, disabled | — |
| RDDTc | `0xb20000000000000000000066242d4067724cB7A1` | 8 | — | Registration required; discovery only, disabled | — |
| SOUNc | `0xb2000000000000000000002137743d4a01fe4e88` | 8 | — | Registration required; discovery only, disabled | — |
| TTWOc | `0xB200000000000000000000f720C26062Bc3067Da` | 8 | — | Registration required; discovery only, disabled | — |
| WENc | `0xb20000000000000000000044e3cd7a0e1028e57a` | 8 | — | Registration required; discovery only, disabled | — |
| AEOc | `0xB2000000000000000000006064f8EC027f042294` | 8 | — | Not-live catalog entry; excluded | — |
| AMCc | `0xB200000000000000000000CD7e6b8042cb7c2BB5` | 8 | — | Not-live catalog entry; excluded | — |
| BIRDc | `0xb200000000000000000000535fE96f18204BFD96` | 8 | — | Not-live catalog entry; excluded | — |
| BMNRc | `0xB200000000000000000000eA2df44A307CaB279C` | 8 | — | Not-live catalog entry; excluded | — |
| BYNDc | `0xB200000000000000000000801830b13b8E493423` | 8 | — | Not-live catalog entry; excluded | — |
| CIFRc | `0xB200000000000000000000690275843B6e246286` | 8 | — | Not-live catalog entry; excluded | — |
| CLSKc | `0xB200000000000000000000fa63cFFF5c794dbB95` | 8 | — | Not-live catalog entry; excluded | — |
| CRWVc | `0xb200000000000000000000F111184A74720787E6` | 8 | — | Not-live catalog entry; excluded | — |
| HUTc | `0xb2000000000000000000006Ee1C139a723872e09` | 8 | — | Not-live catalog entry; excluded | — |
| KSSc | `0xB200000000000000000000105A1f43ff3605C5De` | 8 | — | Not-live catalog entry; excluded | — |
| LCIDc | `0xB20000000000000000000081050Ac3d4395Df527` | 8 | — | Not-live catalog entry; excluded | — |
| MARAc | `0xb200000000000000000000a310e034E09186Fb2d` | 8 | — | Not-live catalog entry; excluded | — |
| OPENc | `0xb200000000000000000000259694B27Bf052E7d7` | 8 | — | Not-live catalog entry; excluded | — |
| RIOTc | `0xb200000000000000000000bd0C7627b663c581A6` | 8 | — | Not-live catalog entry; excluded | — |
| USDEc | `0xB2000000000000000000009426B660396eBCf343` | 8 | — | Not-live catalog entry; excluded | — |
| VVVc | `0xb200000000000000000000FEC679b39992F67627` | 8 | — | Not-live catalog entry; excluded | — |
| WULFc | `0xb200000000000000000000432a1d2Bd864ACEc82` | 8 | — | Not-live catalog entry; excluded | — |
| WWc | `0xB20000000000000000000089221e238277d52515` | 8 | — | Not-live catalog entry; excluded | — |
| XYZc | `0xb20000000000000000000067C8C151f24E1c9924` | 8 | — | Not-live catalog entry; excluded | — |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | — | Registration required; discovery only, disabled | — |
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | 18 | — | Registration required; discovery only, disabled | — |
| cbDOGE | `0xcbD06E5A2B0C65597161de254AA074E489dEb510` | 8 | — | Registration required; discovery only, disabled | — |
| cbXRP | `0xcb585250f852C6c6bf90434AB21A00f02833a4af` | 6 | — | Registration required; discovery only, disabled | — |
| cbLTC | `0xcb17C9Db87B595717C857a08468793f5bAb6445F` | 8 | — | Registration required; discovery only, disabled | — |
| cbADA | `0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c` | 6 | — | Registration required; discovery only, disabled | — |

## Exact approved execution identities and pool keys

- Executor: `0xD982726e28275661F8aB64054E6b17a70a63505A`. Fee recipient (unchanged): `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`. Fee: floor(gross SELL atomic amount × 25 / 10000), never buy-side or a later transfer. 6/8/18-decimal fixtures exercise both directions.
- Native ETH uses the canonical WETH pool but exact gross native value on sell and output unwrap on buy; no ERC-20 approval for native ETH. ETH↔WETH and identical contracts are rejected before quoting.

| Registered unordered pair (both directions) | Router | Kind | Quoter | Exact pool key |
|---|---|---:|---|---|
| USDC ↔ WETH | `0x2626664c2603336E57B271c5C0b26F421741e481` | 2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | Uniswap V3 fee 3000; pool 0x6c561B446416E1A00E8E93E221854d6eA4171372 |
| USDC ↔ AAPLc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ AMZNc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ COINc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ CRCLc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ GOOGLc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ INTCc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ METAc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ MSFTc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ MSTRc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ NVDAc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ SNDKc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ SPCXc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |
| USDC ↔ TSLAc | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | 1 | `0x514c8B5f54112481E28028F1166Bd78501089259` | Slipstream tickSpacing 10; pool address not freshly verified |

## Specific unresolved blockers

- **MPGR**: `0xB2000000000000000000008d204203177a78AF01`, catalog decimals 18; no assisted token/route registration. Committed deployment snapshot omits it; no fresh mapping read. USDC→MPGR and MPGR→USDC remain blocked. Need exact deployed token/router permission reads, ERC-20 metadata and transfer compatibility, and approved compatible pool/quote evidence before code-only registration can be considered. If the committed permission snapshot remains current, owner allowlisting is required and is NOT authorized by this work.
- **28 selectable B20 and six extra wrapped assets**: exact addresses above have no approved route registration. Need the same permission, metadata, compatibility and single-pool evidence. Do not infer insufficient liquidity or invalid contracts from this absence.
- **22 not-live B20**: source catalog lifecycle excludes them, including registered COINc/CRCLc/INTCc. Do not make them selectable from registry membership alone. Their live issuance/readiness is not verified here.
- **B20↔B20, WETH/ETH↔B20 and other nonregistered combinations**: no approved direct route; existing architecture does not add multihop. Use a registered counterasset explicitly, with separate review of each independent swap if desired; no automatic intermediate trade.
- **Arbitrary imports**: metadata validation is separate from execution registration; unknown or duplicate-symbol addresses retain neutral logos and cannot inherit a known token's capability. Validation failure is actionable and never replaced with guessed decimals.

## Scope preserved

Agent quote API and helper, autonomous runtime, goal-bound authorization, wallet creation, AI/vendor settings, deployed contracts/permissions, signing semantics, production gates/settings and provider integrations remain unchanged. Registered-route failures never select CDP/0x/Aerodrome/Uniswap fallback calldata outside the approved Executor. Receipt/event verification is still required before collection/success claims. PR remains open/unmerged.

## Implementation and evidence

- Dedicated authenticated `/api/swap/quote`: dropping the fee flag remains strict; explicitly disabling it is rejected. Shared `/api/trade/quote` and manual Agent helper are unchanged. Separate strict cache; no alternative provider fallback.
- Exact-address, registry-derived selector prioritizes registered combinations, explains counterasset/registration blockers, preserves imported metadata for discovery without granting execution capability, and never silently changes the pay asset.
- Quote admission and signing independently derive the slippage minimum from the original quoted output. Settlement intentionally verifies committed minimum and actual receipt/event output instead; actual historical output is not treated as an original quote.
- Unknown live allowance blocks before approval and swap phases. Newly sufficient allowance requires fresh review rather than a redundant approval; confirmed approval is retained across a refreshed review. Final swap allowance reread also rejects invalid/unknown values.
- Actionable errors replace raw HTTP prefixes while retaining authentication error identity, explicit retries and quote/amount/account/asset/freshness guards.
- Logos remain exact-address trusted assets or neutral fallbacks; no new token artwork or symbol-derived import logo was added.

Full command/results, unsuccessful intermediate checks and isolated 360/390/desktop screenshots: [evidence README](evidence/pr113-swap-hardening/README.md). Final complete unit run: **3913 PASS / 24 SKIP**, existing Agent tests unchanged. Standard build passed with only an external local-font test fixture; production settings were untouched. Browser results: initial Swap 85/86, timed-out case sequential retry 2/2, native/desktop 20/20. These results do not establish live liquidity or authorize broader route registration.
