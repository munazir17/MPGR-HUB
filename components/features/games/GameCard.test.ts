import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

import { GameCard } from "./GameCard";
import { GAME_REGISTRY } from "@/lib/games/game-registry";

const GAME = GAME_REGISTRY.find((g) => g.id === "mpgr-run") ?? GAME_REGISTRY[0];

describe("GameCard image loading (Task 12)", () => {
  it("lazy-loads the below-fold card icon with async decoding", () => {
    const html = renderToStaticMarkup(createElement(GameCard, { game: GAME, bestScore: 1234 }));
    expect(html).toContain(`src="${GAME.iconImage}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("keeps the 44px slot on the thumbnail, not full-size art", () => {
    expect(GAME.iconImage).toContain("-128.webp");
  });
});
