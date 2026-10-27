import { describe, expect, it } from "vitest";
import { Attribution } from "ox/erc8021";
import { MPGR_BUILDER_CODE, MPGR_BUILDER_DATA_SUFFIX, withBuilderSuffix } from "./builder-attribution";

describe("MPGR builder attribution", () => {
  it("uses the registered base.dev code, not a transposed one", () => {
    expect(MPGR_BUILDER_CODE).toBe("bc_6w84mi9m");
    expect(MPGR_BUILDER_CODE).not.toBe("bc_6w84im9m");
    const decoded = Attribution.fromData(MPGR_BUILDER_DATA_SUFFIX);
    expect(decoded?.codes).toContain("bc_6w84mi9m");
    expect(withBuilderSuffix({ to: "0x1" }).dataSuffix).toBe(MPGR_BUILDER_DATA_SUFFIX);
  });
});
