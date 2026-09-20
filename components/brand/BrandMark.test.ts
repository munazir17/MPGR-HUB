import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

import { BrandMark, MpgrMark } from "./BrandMark";

describe("BrandMark image loading (Task 12)", () => {
  it("renders the 128px thumbnail, not the 1.58MB /icon.png", () => {
    const html = renderToStaticMarkup(createElement(BrandMark));
    expect(html).toContain('src="/brand/mpgr-mark-128.webp"');
    expect(html).not.toContain('src="/icon.png"');
  });

  it("keeps the header mark eager (above the fold on every page)", () => {
    const html = renderToStaticMarkup(createElement(MpgrMark));
    expect(html).not.toContain("loading=");
  });
});
