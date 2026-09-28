/** Native, event-driven music only. Never called by simulation or rAF. */
export const RUN_MUSIC_SRC = "/games/mpgr-run/audio/neon-circuit.wav";
export const RUN_MUSIC_PREFERENCE = "mpgrhub:preferences:mpgr-run:music:v1";
export const RUN_MUSIC_VOLUME = 0.2;
type Status = "paused" | "starting" | "playing" | "blocked" | "unavailable";
type MusicAudio = Pick<HTMLAudioElement, "src" | "loop" | "volume" | "preload" | "play" | "pause" | "load" | "removeAttribute" | "addEventListener" | "removeEventListener">;
type Preferences = Pick<Storage, "getItem" | "setItem">;

export function createRunMusic(
  createAudio: () => MusicAudio = () => new Audio(),
  preferences: () => Preferences | null = () => window.localStorage,
) {
  let audio: MusicAudio | null = null;
  let active = false, visible = true, mounted = false, pending = false, failed = false, generation = 0;
  let snapshot: { enabled: boolean; status: Status } = { enabled: true, status: "paused" };
  const listeners = new Set<() => void>();
  const publish = (enabled: boolean, status: Status) => {
    if (snapshot.enabled === enabled && snapshot.status === status) return;
    snapshot = { enabled, status };
    for (const listener of listeners) listener();
  };
  const wanted = () => mounted && active && visible && snapshot.enabled;
  const pause = () => {
    generation++; pending = false;
    audio?.pause();
    publish(snapshot.enabled, failed ? "unavailable" : "paused");
  };
  const reconcile = () => {
    if (!wanted()) { pause(); return; }
    if (!audio || failed || pending || snapshot.status === "playing") return;
    const instance = audio, ticket = ++generation;
    pending = true; publish(snapshot.enabled, "starting");
    const rejected = () => {
      if (ticket !== generation) return;
      pending = false;
      publish(snapshot.enabled, failed ? "unavailable" : "blocked");
    };
    try {
      void Promise.resolve(instance.play()).then(() => {
        if (instance !== audio || !wanted()) { instance.pause(); return; }
        if (ticket !== generation) return;
        pending = false; publish(snapshot.enabled, "playing");
      }, rejected);
    } catch { rejected(); }
  };
  const onError = () => { failed = true; pause(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    mount() {
      if (mounted) return;
      mounted = true; failed = false;
      try { publish(preferences()?.getItem(RUN_MUSIC_PREFERENCE) !== "off", "paused"); } catch { /* private mode */ }
      try {
        audio = createAudio(); audio.loop = true; audio.volume = RUN_MUSIC_VOLUME;
        audio.preload = "metadata";
        audio.addEventListener("error", onError);
        audio.src = RUN_MUSIC_SRC;
      } catch { failed = true; publish(snapshot.enabled, "unavailable"); }
      reconcile();
    },
    setActive(value: boolean) { if (active === value) return; active = value; reconcile(); },
    setVisible(value: boolean) { if (visible === value) return; visible = value; reconcile(); },
    setEnabled(value: boolean) {
      try { preferences()?.setItem(RUN_MUSIC_PREFERENCE, value ? "on" : "off"); } catch { /* best effort, separate from game stats */ }
      failed = audio === null && mounted;
      publish(value, failed ? "unavailable" : "paused"); reconcile();
    },
    /** Retry only on real user gestures after an autoplay rejection. */
    gesture() { reconcile(); },
    dispose() {
      mounted = false; pause();
      if (audio) {
        audio.removeEventListener("error", onError);
        audio.removeAttribute("src"); audio.load(); audio = null;
      }
    },
  };
}
export type RunMusic = ReturnType<typeof createRunMusic>;
