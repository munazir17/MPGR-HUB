import type { Logger, PerformanceMetric, PerformanceMonitor } from "./types";
import { logger as defaultLogger } from "./logger";

const MAX_METRICS = 200; // rolling window — diagnostics, not analytics storage

// Phase 3A.5 — lightweight timing utility (objective 7). No analytics
// provider is wired up yet — this just records durations in memory and
// logs them at debug level, so numbers are visible during development.
// Piping these into a real metrics provider later only touches this
// file's `record` method.
export class InMemoryPerformanceMonitor implements PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];

  constructor(private readonly logger: Logger = defaultLogger) {}

  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(label, performance.now() - start);
    }
  }

  timeSync<T>(label: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.record(label, performance.now() - start);
    }
  }

  getMetrics(label?: string): PerformanceMetric[] {
    return label ? this.metrics.filter((m) => m.label === label) : [...this.metrics];
  }

  clear(): void {
    this.metrics = [];
  }

  private record(label: string, durationMs: number): void {
    this.metrics.push({ label, durationMs, timestamp: new Date().toISOString() });
    if (this.metrics.length > MAX_METRICS) this.metrics.shift();
    this.logger.debug(`${label} took ${durationMs.toFixed(1)}ms`);
  }
}

export const agentPerformanceMonitor: PerformanceMonitor = new InMemoryPerformanceMonitor();
