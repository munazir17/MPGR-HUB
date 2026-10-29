/**
 * Chain read cadence shared by staking and token-lock hooks.
 *
 * Existing screens poll. A snapshot reader (the navbar holder badge) passes
 * `{ poll: false }` so it still loads the connected wallet once and does not
 * keep a timer. Default is poll, so every current caller keeps today's cadence.
 */
export interface LiveReadOptions {
  poll?: boolean;
}

export function shouldPollLiveReads(options?: LiveReadOptions): boolean {
  return options?.poll !== false;
}
