import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// components/layout/AppSidebar.render.test.ts
//
// Renders the real AppSidebar (open state) to a string and locks the
// sidebar's information architecture:
//
//   - it contains the secondary MPGR ecosystem sections,
//   - every link targets an EXISTING app route (no invented pages),
//   - it does NOT contain a Stocks entry (the Base Stocks terminal
//     lives inside the Home MPGR AGENT; there is no Stocks tab),
//   - the wallet stays reachable from the drawer.
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

/** Every page route that actually exists in app/ (no invented links). */
const EXISTING_ROUTES = new Set([
  "/",
  "/rewards",
  "/profile",
  "/games",
  "/games/mpgr-run",
  "/leaderboard",
  "/staking",
  "/app/token-lock",
  "/burn",
  "/token",
  "/season",
  "/season-pass",
  "/docs",
  "/whitepaper",
  "/roadmap",
  "/about",
  "/support",
  "/terms",
  "/privacy",
]);

describe("AppSidebar (rendered)", () => {
  const html = renderToString(createElement(AppSidebar, { open: true, onClose: () => {} }));

  it("renders the drawer with the expected group titles", () => {
    expect(html).toContain("MPGR HUB menu");
    for (const group of ["Rewards", "Play", "Ecosystem", "Learn", "Account"]) {
      expect(html).toContain(group);
    }
  });

  it("contains the secondary ecosystem sections", () => {
    for (const label of [
      "Reward Hub",
      "Season",
      "Season Pass",
      "Leaderboard",
      "Games",
      "MPGR Run",
      "Staking",
      "Token Lock",
      "$MPGR",
      "Docs",
      "Whitepaper",
      "Roadmap",
      "About",
      "Profile",
    ]) {
      expect(html).toContain(label);
    }
    // Rendered HTML escapes the ampersand.
    expect(html).toContain("Support &amp; FAQ");
  });

  it("links only to routes that actually exist", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(EXISTING_ROUTES.has(href)).toBe(true);
    }
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
