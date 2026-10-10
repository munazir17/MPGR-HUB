import { beforeEach } from "vitest";

import { setEmergencySwitchReaderForTests } from "@/lib/autonomy/emergency-switch";

/**
 * Default test posture: the KV switch is an explicit ENABLED record.
 * Suites that prove fail-closed behaviour must override this in their own
 * beforeEach (resetEmergencySwitchForTests / setEmergencySwitchKvForTests).
 */
beforeEach(() => {
  setEmergencySwitchReaderForTests(async () => ({
    allowed: true,
    reason: "ENABLED",
    correlationId: "test-default-enabled",
  }));
});
