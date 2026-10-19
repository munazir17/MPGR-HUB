# V2 unlock callback — consume authorization before interactions

The `reentrancy-eth` high finding on the V2 callback is fixed in V2 only.
No detector exclusions, inline Slither suppressions, legacy contracts, or V1
release/deployment files are changed.

`unlockCallback` now:

1. Requires the canonical Base PoolManager, an entered outer reentrancy guard,
   and the exact live one-use callback commitment.
2. Clears that commitment **before** `swap`, any hook, settlement, or `take`.
3. Performs no storage writes after those interactions.

The outer single and split entry points remain `nonReentrant`. Native output
from PoolManager `take` is accepted only from that manager while an outer guard
is entered; native receipt does not grant or restore callback authorization.
A second callback (even with the manager's identity and original bytes) sees a
consumed commitment and reverts. A hook calling either swap entry fails the
outer reentrancy guard. A hook calling the callback directly is not the manager.

Five new deterministic adversarial tests cover single entry reentry, split entry
reentry, direct callback reentry, manager-identity replay of the original callback,
and reentry during an outer split. The malicious hook bubbles its failed attempt:
the full transaction reverts, including gross pull and treasury fee. Assertions
check unchanged user, treasury and manager balances, no second output, no trapped
input/allowance, and a subsequent normal swap paying the fee exactly once.
These are malicious-hook unit fixtures, not a replacement for the Base fork suite.

Local verification:

- V2 Foundry suite: **25 passed**, including five new adversarial cases and
  256 split-fee fuzz runs.
- Exact Slither command: exit **0** (existing lower-severity results remain):
  `slither . --filter-paths "openzeppelin|forge-std" --exclude reentrancy-balance --fail-high`
- Existing second-pass balance checker: **PASS**, only the previously reviewed
  `MPGRExecutorDelegated.swapOnBehalfOfTypedModule` finding allowed.

Production deployment and activation remain conditional on green GitHub Slither,
code-owner review, the trusted merged-main pin, environment approval, preflight
and independently sealed receipt assertions. No gate is opened by this fix.
