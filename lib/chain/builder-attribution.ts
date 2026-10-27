import { Attribution } from "ox/erc8021";
import type { Hex } from "viem";

/**
 * Builder code from base.dev (Settings → Builder Code).
 * The previous value swapped two letters (`im` vs `mi`), so Coinbase Wallet
 * never attributed MPGR HUB and the app stayed off the live builder record.
 */
export const MPGR_BUILDER_CODE = "bc_6w84mi9m";

export const MPGR_BUILDER_DATA_SUFFIX: Hex = Attribution.toDataSuffix({
  codes: [MPGR_BUILDER_CODE],
});

/** Wagmi does not apply createConfig.dataSuffix to connector sends. Pass this on every write. */
export function withBuilderSuffix<T extends object>(tx: T): T & { dataSuffix: Hex } {
  return { ...tx, dataSuffix: MPGR_BUILDER_DATA_SUFFIX };
}
