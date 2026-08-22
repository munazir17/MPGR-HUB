// lib/games/mpgr-run/asset-loader.ts
//
// Browser-only sprite pipeline for MPGR Run.
//
// Contract:
// - Never blocks gameplay. Callers fire this on mount and forget it.
// - A sprite enters the ready cache ONLY after load + decode (+ optional
//   background-strip) succeed. onload-before-decode is the iOS Safari
//   "blank then pop" class of bug; we don't put those in the cache.
// - True slot concurrency: an asset occupies a slot from the moment its
//   request starts until it has completely settled (ready, failed, or
//   timed out). A timer that starts N images every X ms is NOT a
//   concurrency limit — this loader does not do that.
// - Optional assets MUST NOT start until every critical asset has
//   settled. Starting optional because critical merely *began* is the
//   bug this exists to prevent.
// - Failures (404, decode throw, timeout) are sticky for this page
//   lifetime so we don't retry forever. A still-in-flight image that is
//   merely slow is allowed to finish later and then enter the cache,
//   unless it already timed out.
// - Ready cache is write-once per src: a later load cannot overwrite a
//   decoded current-version sprite with anything else.
// - This module never starts, stops, or observes the game rAF loop.

export type SpriteReadyCache = Map<string, CanvasImageSource>;

/** Minimal image surface so tests can inject fakes without jsdom Image. */
export interface LoadableImage {
  src: string;
  decoding: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: ((this: LoadableImage, ev?: unknown) => unknown) | null;
  onerror: ((this: LoadableImage, ev?: unknown) => unknown) | null;
}

export interface RunAssetPipelineDeps {
  createImage?: () => LoadableImage;
  decode?: (img: LoadableImage) => Promise<void>;
  scheduleTimeout?: (cb: () => void, ms: number) => number;
  cancelTimeout?: (id: number) => void;
}

export interface RunAssetPipelineOptions {
  critical: readonly string[];
  optional: readonly string[];
  ready: SpriteReadyCache;
  inflight: Set<string>;
  failed: Set<string>;
  stripTargets: ReadonlySet<string>;
  stripBackground: (img: HTMLImageElement) => HTMLCanvasElement;
  /** Critical-path in-flight cap. Each PNG is 0.8–2.6MB compressed. */
  criticalConcurrency?: number;
  /** Optional-path in-flight cap. Never overlaps unfinished critical work. */
  optionalConcurrency?: number;
  /** Per-asset timeout. Hung requests release their slot so the queue moves. */
  timeoutMs?: number;
  deps?: RunAssetPipelineDeps;
}

export interface RunAssetPipelineHandle {
  stop: () => void;
  getCriticalInFlight: () => number;
  getOptionalInFlight: () => number;
  getCriticalSettled: () => number;
  optionalHasStarted: () => boolean;
}

export const DEFAULT_CRITICAL_CONCURRENCY = 3;
export const DEFAULT_OPTIONAL_CONCURRENCY = 2;
export const DEFAULT_ASSET_TIMEOUT_MS = 8000;

type Lane = "critical" | "optional";

function defaultCreateImage(): LoadableImage {
  const img = new window.Image();
  img.decoding = "async";
  return img as unknown as LoadableImage;
}

function defaultDecode(img: LoadableImage): Promise<void> {
  const maybe = img as unknown as HTMLImageElement;
  if (typeof maybe.decode === "function") {
    return maybe.decode();
  }
  return Promise.resolve();
}

/**
 * Start a two-tier load of `critical` then `optional` into `ready`.
 * Optional work is gated on critical *settlement*, not kickoff.
 *
 * Gameplay is never awaited on this. Missing sprites render via the
 * existing procedural fallback until (if) they land in `ready`.
 */
export function startRunAssetPipeline(options: RunAssetPipelineOptions): RunAssetPipelineHandle {
  const {
    critical,
    optional,
    ready,
    inflight,
    failed,
    stripTargets,
    stripBackground,
    criticalConcurrency = DEFAULT_CRITICAL_CONCURRENCY,
    optionalConcurrency = DEFAULT_OPTIONAL_CONCURRENCY,
    timeoutMs = DEFAULT_ASSET_TIMEOUT_MS,
    deps = {},
  } = options;

  const createImage = deps.createImage ?? defaultCreateImage;
  const decode = deps.decode ?? defaultDecode;
  const scheduleTimeout = deps.scheduleTimeout ?? ((cb, ms) => window.setTimeout(cb, ms));
  const cancelTimeout = deps.cancelTimeout ?? ((id) => window.clearTimeout(id));

  let cancelled = false;
  let criticalInFlight = 0;
  let optionalInFlight = 0;
  let criticalSettled = 0;
  let optionalStarted = false;

  const criticalQueue = critical.filter((src) => !!src);
  const optionalQueue = optional.filter((src) => !!src);
  const criticalTotal = criticalQueue.length;
  const timeoutIds = new Set<number>();

  const commit = (src: string, source: CanvasImageSource) => {
    inflight.delete(src);
    if (ready.has(src) || failed.has(src)) return;
    ready.set(src, source);
  };

  const markFailed = (src: string) => {
    inflight.delete(src);
    if (ready.has(src)) return;
    failed.add(src);
  };

  const releaseTimeout = (id: number | null) => {
    if (id == null) return;
    timeoutIds.delete(id);
    cancelTimeout(id);
  };

  const loadOne = (src: string, lane: Lane) => {
    if (cancelled) return;

    if (ready.has(src) || failed.has(src) || inflight.has(src)) {
      onSettled(lane, false);
      return;
    }

    if (lane === "critical") criticalInFlight += 1;
    else optionalInFlight += 1;
    inflight.add(src);

    let settled = false;
    let timeoutId: number | null = null;
    const img = createImage();
    img.decoding = "async";

    const settle = (ok: boolean, source?: CanvasImageSource) => {
      if (settled) return;
      settled = true;
      releaseTimeout(timeoutId);
      if (!cancelled) {
        if (ok && source) commit(src, source);
        else markFailed(src);
      } else {
        inflight.delete(src);
      }
      onSettled(lane, true);
    };

    timeoutId = scheduleTimeout(() => {
      settle(false);
    }, timeoutMs);
    timeoutIds.add(timeoutId);

    img.onload = () => {
      if (cancelled || settled) {
        settle(false);
        return;
      }
      Promise.resolve()
        .then(() => decode(img))
        .then(() => {
          if (cancelled || settled) {
            settle(false);
            return;
          }
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            settle(false);
            return;
          }
          if (stripTargets.has(src)) {
            try {
              settle(true, stripBackground(img as unknown as HTMLImageElement));
            } catch {
              settle(false);
            }
            return;
          }
          settle(true, img as unknown as CanvasImageSource);
        })
        .catch(() => {
          settle(false);
        });
    };

    img.onerror = () => {
      settle(false);
    };

    try {
      img.src = src;
    } catch {
      settle(false);
    }
  };

  const pumpCritical = () => {
    if (cancelled) return;
    while (criticalInFlight < criticalConcurrency && criticalQueue.length > 0) {
      const src = criticalQueue.shift() as string;
      loadOne(src, "critical");
    }
  };

  const pumpOptional = () => {
    if (cancelled || !optionalStarted) return;
    while (optionalInFlight < optionalConcurrency && optionalQueue.length > 0) {
      const src = optionalQueue.shift() as string;
      loadOne(src, "optional");
    }
  };

  const maybeStartOptional = () => {
    if (optionalStarted || cancelled) return;
    if (criticalSettled < criticalTotal) return;
    optionalStarted = true;
    pumpOptional();
  };

  const onSettled = (lane: Lane, occupiedSlot: boolean) => {
    if (lane === "critical") {
      if (occupiedSlot) criticalInFlight = Math.max(0, criticalInFlight - 1);
      criticalSettled += 1;
      pumpCritical();
      maybeStartOptional();
    } else {
      if (occupiedSlot) optionalInFlight = Math.max(0, optionalInFlight - 1);
      pumpOptional();
    }
  };

  pumpCritical();
  maybeStartOptional();

  const handle: RunAssetPipelineHandle = {
    stop: () => {
      cancelled = true;
      timeoutIds.forEach((id) => cancelTimeout(id));
      timeoutIds.clear();
    },
    getCriticalInFlight: () => criticalInFlight,
    getOptionalInFlight: () => optionalInFlight,
    getCriticalSettled: () => criticalSettled,
    optionalHasStarted: () => optionalStarted,
  };
  return handle;
}
