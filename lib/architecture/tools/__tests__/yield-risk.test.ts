import { describe, expect, it } from "vitest";

import {
  classifyDataQuality,
  classifyLiquidityRisk,
  classifyProtocolRisk,
  classifyRewardSustainability,
  classifySmartContractRisk,
  classifyVolatilityExposure,
  classifyWithdrawalRisk,
  overallYieldRisk,
} from "../yield-risk";

import type { YieldRiskFactor } from "../yield-types";

describe("classifyLiquidityRisk", () => {
  it("is low with no lock and no cooldown", () => {
    expect(classifyLiquidityRisk(false, false).level).toBe("low");
  });

  it("is medium with a lock", () => {
    expect(classifyLiquidityRisk(true, false).level).toBe("medium");
  });

  it("is medium with a cooldown", () => {
    expect(classifyLiquidityRisk(false, true).level).toBe("medium");
  });
});

describe("classifyVolatilityExposure", () => {
  it("is unknown when no market-data provider exists", () => {
    expect(classifyVolatilityExposure().level).toBe("unknown");
  });
});

describe("classifyProtocolRisk", () => {
  it("is unknown when pause status cannot be read", () => {
    expect(classifyProtocolRisk(null).level).toBe("unknown");
  });

  it("is high when paused", () => {
    expect(classifyProtocolRisk(true).level).toBe("high");
  });

  it("is low when not paused", () => {
    expect(classifyProtocolRisk(false).level).toBe("low");
  });
});

describe("classifySmartContractRisk", () => {
  it("is unknown when no audit data source exists", () => {
    expect(classifySmartContractRisk().level).toBe("unknown");
  });
});

describe("classifyWithdrawalRisk", () => {
  it("is low with no early-exit penalty", () => {
    expect(classifyWithdrawalRisk(false).level).toBe("low");
  });

  it("is medium with an early-exit penalty", () => {
    expect(classifyWithdrawalRisk(true).level).toBe("medium");
  });
});

describe("classifyRewardSustainability", () => {
  const now = 1_000_000n;

  it("is unknown when required data is missing", () => {
    expect(
      classifyRewardSustainability(
        null,
        1n,
        2_000_000n,
        now
      ).level
    ).toBe("unknown");

    expect(
      classifyRewardSustainability(
        100n,
        null,
        2_000_000n,
        now
      ).level
    ).toBe("unknown");

    expect(
      classifyRewardSustainability(
        100n,
        1n,
        null,
        now
      ).level
    ).toBe("unknown");
  });

  it("is medium when the reward period has ended", () => {
    expect(
      classifyRewardSustainability(
        1000n,
        1n,
        500_000n,
        now
      ).level
    ).toBe("medium");
  });

  it("is medium when reward rate is zero", () => {
    expect(
      classifyRewardSustainability(
        1000n,
        0n,
        2_000_000n,
        now
      ).level
    ).toBe("medium");
  });

  it("is medium when the pool cannot sustain the remaining period", () => {
    expect(
      classifyRewardSustainability(
        1000n,
        10n,
        2_000_000n,
        now
      ).level
    ).toBe("medium");
  });

  it("is low when the pool covers the remaining period", () => {
    expect(
      classifyRewardSustainability(
        2_000_000n,
        1n,
        2_000_000n,
        now
      ).level
    ).toBe("low");
  });
});

describe("classifyDataQuality", () => {
  it("is low when current", () => {
    expect(
      classifyDataQuality("current").level
    ).toBe("low");
  });

  it("is medium when stale", () => {
    expect(
      classifyDataQuality("stale").level
    ).toBe("medium");
  });

  it("is high when unavailable", () => {
    expect(
      classifyDataQuality("unavailable").level
    ).toBe("high");
  });

  it("is high when unknown", () => {
    expect(
      classifyDataQuality("unknown").level
    ).toBe("high");
  });
});

describe("overallYieldRisk", () => {
  it("is unknown when every factor is unknown", () => {
    const factors: YieldRiskFactor[] = [
      {
        dimension: "volatilityExposure",
        level: "unknown",
        reason: "x",
      },
      {
        dimension: "smartContractRisk",
        level: "unknown",
        reason: "x",
      },
    ];

    expect(overallYieldRisk(factors)).toBe("unknown");
  });

  it("ignores unknown factors when computing known risk", () => {
    const factors: YieldRiskFactor[] = [
      {
        dimension: "liquidityRisk",
        level: "low",
        reason: "x",
      },
      {
        dimension: "volatilityExposure",
        level: "unknown",
        reason: "x",
      },
    ];

    expect(overallYieldRisk(factors)).toBe("low");
  });

  it("returns the worst known level", () => {
    const factors: YieldRiskFactor[] = [
      {
        dimension: "liquidityRisk",
        level: "low",
        reason: "x",
      },
      {
        dimension: "protocolRisk",
        level: "high",
        reason: "x",
      },
      {
        dimension: "withdrawalRisk",
        level: "medium",
        reason: "x",
      },
    ];

    expect(overallYieldRisk(factors)).toBe("high");
  });

  it("returns unknown for an empty factor list", () => {
    expect(overallYieldRisk([])).toBe("unknown");
  });
});
