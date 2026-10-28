import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function skillFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...skillFiles(path));
    else if (name === "SKILL.md") found.push(path);
  }
  return found;
}

describe("MPGR skills v2", () => {
  const files = skillFiles(fileURLToPath(new URL(".", import.meta.url)));

  it("ships the three Binance-style skills and no extra engine", () => {
    expect(files.map((file) => file.split("/").at(-2)).sort()).toEqual(["mpgr-agent", "mpgr-mcp", "paigerswap"]);
  });

  it("uses version 2 frontmatter and does not embed a secret", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/^---\nname: [a-z0-9-]+\n/);
      expect(source).toMatch(/version:\s*"2\.0"/);
      expect(source).toMatch(/author:\s*munazir17/);
      expect(source).toMatch(/license:\s*All Rights Reserved/);
      expect(source).not.toMatch(/nvapi-|NEXT_PUBLIC_NVIDIA|BEGIN PRIVATE KEY/);
      expect(source.toLowerCase()).toMatch(/wallet/);
      expect(source.toLowerCase()).not.toMatch(/second (swap )?engine|broadcast the swap yourself/);
    }
  });
});
