import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { isolateMusicKeys } from "@/components/features/games/mpgr-run/RunGameMusic";
import path from "node:path";
import { createRunMusic, RUN_MUSIC_SRC, RUN_MUSIC_PREFERENCE } from "./run-music";

function fixture(preference: string | null = null) {
  const events = new Map<string, EventListener>();
  const audio = { src: "", preload: "", loop: false, volume: 1,
    play: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => events.set(type, listener)),
    removeEventListener: vi.fn((type: string) => events.delete(type)),
  };
  const storage = { getItem: vi.fn(() => preference), setItem: vi.fn() };
  const music = createRunMusic(() => audio as unknown as HTMLAudioElement, () => storage);
  music.mount();
  return { audio, storage, music, events };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("isolated native Run music", () => {
  it("isolates music-button keys without suppressing native button activation", () => {
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    isolateMusicKeys(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("uses a local looping asset, metadata preload and 20% gain without starting in idle", () => {
    const { audio, music } = fixture();
    expect(audio).toMatchObject({ src: RUN_MUSIC_SRC, loop: true, volume: 0.2, preload: "metadata" });
    expect(audio.play).not.toHaveBeenCalled(); expect(music.getSnapshot().enabled).toBe(true);
  });
  it("starts synchronously at activation, without awaiting audio before returning", async () => {
    const { audio, music } = fixture(); music.setActive(true);
    expect(audio.play).toHaveBeenCalledOnce();
    for (let i = 0; i < 100; i++) music.gesture();
    expect(audio.play).toHaveBeenCalledOnce();
    await flush(); expect(music.getSnapshot().status).toBe("playing");
    for (let i = 0; i < 100; i++) music.gesture();
    expect(audio.play).toHaveBeenCalledOnce();
  });
  it("pauses/resumes for phase and visibility without seeking", async () => {
    const { audio, music } = fixture(); music.setActive(true); await flush();
    music.setActive(false); expect(music.getSnapshot().status).toBe("paused");
    music.setActive(true); await flush(); music.setVisible(false);
    expect(music.getSnapshot().status).toBe("paused");
    music.setActive(false); music.setVisible(true); expect(audio.play).toHaveBeenCalledTimes(2);
    music.setActive(true); await flush(); expect(audio.play).toHaveBeenCalledTimes(3);
    expect(audio.pause).toHaveBeenCalled();
  });
  it("persists off separately from stats and retries when explicitly enabled", async () => {
    const { audio, music, storage } = fixture("off"); music.setActive(true);
    expect(audio.play).not.toHaveBeenCalled(); music.setEnabled(true); await flush();
    expect(audio.play).toHaveBeenCalledOnce(); music.setEnabled(false);
    expect(storage.setItem).toHaveBeenLastCalledWith(RUN_MUSIC_PREFERENCE, "off");
    expect(music.getSnapshot()).toEqual({ enabled: false, status: "paused" });
    music.setVisible(false); music.setVisible(true); music.gesture(); expect(audio.play).toHaveBeenCalledOnce();
  });
  it("contains autoplay rejection and retries on a later gesture", async () => {
    const { audio, music } = fixture(); audio.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    music.setActive(true); await flush(); expect(music.getSnapshot().status).toBe("blocked");
    music.gesture(); await flush(); expect(music.getSnapshot().status).toBe("playing");
  });
  it("contains synchronous play failure, storage denial and audio construction failure", () => {
    const { audio, music } = fixture(); audio.play.mockImplementation(() => { throw new Error("not allowed"); });
    expect(() => music.setActive(true)).not.toThrow(); expect(music.getSnapshot().status).toBe("blocked");
    const unavailable = createRunMusic(() => { throw new Error("no audio"); }, () => { throw new Error("private mode"); });
    expect(() => { unavailable.mount(); unavailable.setEnabled(false); unavailable.setActive(true); unavailable.dispose(); }).not.toThrow();
  });
  it("a late play resolution cannot undo a pause or failed-start cancellation", async () => {
    const { audio, music } = fixture(); let resolve!: () => void;
    audio.play.mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
    music.setActive(true); music.setActive(false); resolve(); await flush();
    expect(music.getSnapshot().status).toBe("paused");
    music.setActive(true); await flush(); expect(music.getSnapshot().status).toBe("playing");
  });
  it("stops pending playback on exit and releases the media source", async () => {
    const { audio, music, events } = fixture(); let resolve!: () => void;
    audio.play.mockReturnValue(new Promise<void>(done => { resolve = done; }));
    music.setActive(true); music.dispose(); resolve(); await flush();
    expect(music.getSnapshot().status).toBe("paused"); expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src"); expect(audio.load).toHaveBeenCalledOnce(); expect(events.size).toBe(0);
    music.gesture(); expect(audio.play).toHaveBeenCalledOnce();
  });
  it("handles missing media without throwing or repeated gesture requests", () => {
    const { music, audio, events } = fixture();
    events.get("error")!(new Event("error")); music.setActive(true);
    for (let i = 0; i < 20; i++) music.gesture();
    expect(music.getSnapshot().status).toBe("unavailable"); expect(audio.play).not.toHaveBeenCalled();
  });
  it("notifies only on status changes and cleans subscriptions", async () => {
    const { music } = fixture(); const listener = vi.fn(), stop = music.subscribe(listener);
    music.gesture(); expect(listener).not.toHaveBeenCalled(); music.setActive(true); await flush();
    expect(listener).toHaveBeenCalledTimes(2); stop(); music.setActive(false); expect(listener).toHaveBeenCalledTimes(2);
  });
  it("ships a licensed, uncompressed 30-second loop with matched boundary samples", () => {
    const file = path.join(process.cwd(), "public", RUN_MUSIC_SRC);
    const wav = fs.readFileSync(file);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF"); expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(44100); expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40) / 2 / 44100).toBe(30);
    expect(wav.readInt16LE(44)).toBe(wav.readInt16LE(wav.length - 2));
    let peak = 0; for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    expect(peak).toBeGreaterThan(24000); expect(peak).toBeLessThan(30000);
    expect(fs.readFileSync(path.join(path.dirname(file), "LICENSE.md"), "utf8")).toContain("CC0 1.0");
  });
});
