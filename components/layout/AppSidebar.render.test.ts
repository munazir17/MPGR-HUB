import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// components/layout/AppSidebar.render.test.ts
//
// Renders the real AppSidebar (open state) to a string and locks its
// information architecture. The sidebar is deliberately short —
// exactly these entries:
//
//   REWARDS:   Reward Hub, Leaderboard
//   PLAY:      Games, MPGR Run
//   ECOSYSTEM: Staking, Token Lock, Burn, $MPGR
//   ACCOUNT:   Profile
//
// Everything else (Season, Season Pass, Docs, Whitepaper, Roadmap,
// About, Support, legal) must NOT appear — those routes still exist
// and stay reachable from the Home footer, they are just not sidebar
// entries. The wallet must remain reachable inside the drawer.
//
// JSX is expressed with createElement because this repo's vitest config
// only picks up *.test.ts files.

vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: () => createElement("div", { "data-testid": "sidebar-connect" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) =>
    createElement("a", { href: props.href }, children),
}));

const { AppSidebar } = await import("@/components/layout/AppSidebar");

const EXPECTED_ENTRIES: Record<string, string> = {
  "Reward Hub": "/rewards",
  Leaderboard: "/leaderboard",
  Games: "/games",
  "MPGR Run": "/games/mpgr-run",
  Staking: "/staking",
  "Token Lock": "/app/token-lock",
  Burn: "/burn",
  $MPGR: "/token",
  Profile: "/profile",
};

const REMOVED_LABELS = [
  "Season",
  "Season Pass",
  "Docs",
  "Whitepaper",
  "Roadmap",
  "About",
  "Support",
  "Terms",
  "Privacy",
];

describe("AppSidebar (rendered)", () => {
  const html = renderToString(createElement(AppSidebar, { open: true, onClose: () => {} }));

  it("renders the drawer with exactly the four requested groups", () => {
    expect(html).toContain("MPGR HUB menu");
    for (const group of ["Rewards", "Play", "Ecosystem", "Account"]) {
      expect(html).toContain(group);
    }
    // The old "Learn" group is gone.
    expect(html).not.toContain('aria-label="Learn"');
  });

  it("contains exactly the requested navigation entries", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    // BrandMark's home link + the nine entries (order-insensitive).
    expect([...hrefs].sort()).toEqual(["/", ...Object.values(EXPECTED_ENTRIES)].sort());
    for (const [label, href] of Object.entries(EXPECTED_ENTRIES)) {
      expect(html).toContain(`>${label}<`);
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("contains none of the removed secondary entries", () => {
    for (const label of REMOVED_LABELS) {
      expect(html).not.toContain(`>${label}<`);
    }
    expect(html).not.toContain('href="/season"');
    expect(html).not.toContain('href="/season-pass"');
    expect(html).not.toContain('href="/docs"');
    expect(html).not.toContain('href="/whitepaper"');
    expect(html).not.toContain('href="/roadmap"');
    expect(html).not.toContain('href="/about"');
    expect(html).not.toContain('href="/support"');
    expect(html).not.toContain('href="/terms"');
    expect(html).not.toContain('href="/privacy"');
  });

  it("has no Stocks entry — the agent on Home is the stocks experience", () => {
    expect(html).not.toContain('href="/agent"');
    expect(html).not.toContain(">Stocks<");
  });

  it("keeps the wallet reachable inside the drawer", () => {
    expect(html).toContain("sidebar-connect");
  });

  it("is a modal dialog with a close button", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Close menu");
  });
});
