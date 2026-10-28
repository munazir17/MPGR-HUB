// User-facing copy only. Internal quote and settlement reasons stay exact for
// logs and tests; the swap screen never prints executor or calldata language.
const RULES: readonly [RegExp, string][] = [
  [/does not match the reviewed swap|mined calldata is not V2|does not target the MPGR V2|not sent by the signed-in wallet|not a single swap from the signed-in wallet/i, "This swap could not be confirmed. Check it on BaseScan before trying again."],
  [/could not be verified yet|receipt hash does not match|execution and fee collection are unverified/i, "Submitted. Wait for confirmation on BaseScan before trying again."],
  [/direct-pool evidence|reviewed MPGR executors|no qualified direct pool|no route through|no liquid V2 route|liquidity discovery is unavailable/i, "No route for this pair right now. Try another token or amount."],
  [/preview discovery is unavailable|pricing is busy right now|could not verify this route/i, "This pair could not be priced just now. Refresh the quote and try again."],
  [/route discovery could not finish|deployment floor could not be derived|archive requests require a personal token|canonical event sweep unavailable/i, "This pair could not be priced just now. Refresh the quote and try again."],
  [/does not match the reviewed tokens|executable (?:V2 |path )?transaction does not match/i, "This quote changed. Refresh it and review the new amount."],
];

export function publicSwapMessage(message: string): string {
  for (const [pattern, copy] of RULES) if (pattern.test(message)) return copy;
  return message;
}
