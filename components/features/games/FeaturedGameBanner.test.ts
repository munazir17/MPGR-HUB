import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

import { FeaturedGameBanner } from "./FeaturedGameBanner";
import { GAME_REGISTRY } from "@/lib/games/game-registry";

const GAME = GAME_REGISTRY.find((g) => g.featured) ?? GAME_REGISTRY[0];

describe("FeaturedGameBanner image loading (Task 12)", () => {
  it("renders the 256px banner thumbnail with async decoding", () => {
    const html = renderToStaticMarkup(
      createElement(FeaturedGameBanner, { game: GAME, bestScore: 99 })
    );
    expect(html).toContain('src="/games/mpgr-run/character/mpgr-runner-run-256.webp"');
    expect(html).not.toContain('src="/games/mpgr-run/character/mpgr-runner-run.webp"');
    expect(html).toContain('decoding="async"');
  });

  it("keeps the featured CTA eager (near the fold, explicit choice)", () => {
    const html = renderToStaticMarkup(createElement(FeaturedGameBanner, { game: GAME }));
    expect(html).not.toContain("loading=");
  });
});
