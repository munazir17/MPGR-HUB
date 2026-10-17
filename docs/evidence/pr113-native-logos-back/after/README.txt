Deterministic local browser evidence — no live wallet, signatures, broadcast or settlement.

Widths: 360x800, 390x844 and desktop 1280x900.
Each folder contains native-default.png, selector-logos.png and weth-selected.png.
The fixture visibly labels simulated flows. It renders the actual Swap controllers;
its additional Agent fixture panel is not part of the production Swap page.

Native default: USDC pay / native ETH receive, separate native balance of 2.
WETH selected: separate Wrapped Ether ERC20 and balance of 100.
Actual local Ethereum, Wrapped Ether and Circle USDC PNGs loaded successfully.
Native ETH is identified as a native Base asset, never an ERC20 contract.
Unknown/unverified/failed artwork uses a neutral fallback, not a guessed brand.
Header Back target is 44px and uses actual browser history or root fallback.

Screenshots captured from the final frozen-source 26-case local browser run.
The earlier full 180-case run passed all screenshot cases, but had one interrupted case:
editing SwapDetails while the runner was active caused a Vite document reload
in the duplicate-symbol import case (trace confirms navigation to flows.html).
The full run is recorded honestly as 179 passed / 1 interrupted failure.
The final frozen-source focused browser run passed all 26 cases, including
that exact case (both widths) and all new native/logo/Back cases.
