// User-facing copy only. Internal quote and settlement reasons stay exact for
// logs and tests; the swap screen never prints executor or calldata language.
const RULES: readonly [RegExp, string][] = [
  [/does not match the reviewed swap/i, "This swap could not be confirmed. Check it on BaseScan before trying again."],
  [/could not be verified yet|receipt hash does not match|execution and fee collection are unverified/i, "Submitted. Wait for confirmation on BaseScan before trying again."],
  [/direct-pool evidence|reviewed MPGR executors|no qualified direct pool|no route through|no liquid V2 route|liquidity discovery is unavailable/i, "No route for this pair right now. Try another token or amount."],
  [/does not match the reviewed tokens|executable (?:V2 |path )?transaction does not match/i, "This quote changed. Refresh it and review the new amount."],
];

export function publicSwapMessage(message: string): string {
  for (const [pattern, copy] of RULES) if (pattern.test(message)) return copy;
  return message;
}
