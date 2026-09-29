import { describe, expect, it } from "vitest";

import { createRunPointerSession } from "@/components/features/games/mpgr-run/useRunInput";

/**
 * Input-contract regression tests (2026-09-27 critical bug fix):
 * pressing LEFT/RIGHT (button or swipe) must NEVER trigger a jump, and an
 * unmatched pointer release (control buttons stop pointerdown propagation,
 * second fingers, cancelled pointers) must never classify as anything.
 *
 *   LEFT  = one lane left          RIGHT = one lane right
 *   UP    = jump                   DOWN  = slide
 *   tap on play surface = jump (intended convenience, preserved)
 */
describe("run pointer session classification", () => {
  it("horizontal swipes change lane and never jump", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 1);
    expect(s.up(280, 405, 1)).toBe("lane-right");
    s.down(200, 400, 2);
    expect(s.up(120, 396, 2)).toBe("lane-left");
  });

  it("short horizontal gestures never fall through to tap-jump", () => {
    const s = createRunPointerSession();
    for (const dx of [-40, -39, -20, -7, 7, 20, 39, 40]) {
      s.down(200, 400, 1);
      expect(s.up(200 + dx, 402, 1)).toBe(Math.abs(dx) >= 40 ? (dx < 0 ? "lane-left" : "lane-right") : null);
    }
  });

  it("another pointer cannot cancel the owner", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 1);
    s.cancel(2);
    expect(s.up(280, 400, 1)).toBe("lane-right");
  });

  it("vertical swipes jump / slide", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 3);
    expect(s.up(204, 300, 3)).toBe("jump");
    s.down(200, 400, 4);
    expect(s.up(198, 500, 4)).toBe("slide");
  });

  it("a control-button release without a matching down is ignored (the old jump bug)", () => {
    const s = createRunPointerSession();
    // Control buttons stop pointerdown propagation; their pointerup still
    // bubbles. Previously this fell into the `!start -> jump()` fallback.
    expect(s.up(60, 700, 11)).toBeNull();
    expect(s.up(120, 700, 12)).toBeNull();
    expect(s.up(300, 700, 13)).toBeNull();
  });

  it("rapid alternating left/right never produces a jump state", () => {
    const s = createRunPointerSession();
    const seen = new Set<string | null>();
    for (let i = 0; i < 12; i++) {
      const id = 100 + i;
      s.down(200, 400, id);
      seen.add(i % 2 === 0 ? s.up(280, 402, id) : s.up(120, 398, id));
    }
    expect(seen.has("jump")).toBe(false);
    expect(seen.has("lane-left")).toBe(true);
    expect(seen.has("lane-right")).toBe(true);
  });

  it("multi-touch: a second finger's release cannot classify", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 21);
    s.down(260, 420, 22); // second finger cannot steal ownership
    expect(s.up(340, 424, 22)).toBeNull();
    expect(s.up(280, 400, 21)).toBe("lane-right");
    expect(s.up(10, 10, 23)).toBeNull();
  });

  it("cancelled pointers leave no stuck jump/tap state", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 31);
    s.cancel(31);
    expect(s.up(200, 400, 31)).toBeNull();
    // Session stays usable afterwards.
    s.down(200, 400, 32);
    expect(s.up(202, 398, 32)).toBe("jump");
  });

  it("deliberate tap on the play surface still jumps", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 41);
    expect(s.up(203, 397, 41)).toBe("jump");
  });

  it("diagonal movement prefers the dominant axis", () => {
    const s = createRunPointerSession();
    s.down(200, 400, 51);
    expect(s.up(260, 430, 51)).toBe("lane-right"); // |dx| > |dy|
    s.down(200, 400, 52);
    expect(s.up(220, 320, 52)).toBe("jump"); // |dy| > |dx|
  });
});
