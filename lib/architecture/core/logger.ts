import type { LogContext, Logger, LogLevel } from "./types";

// Phase 3A.5 — production-safe logger (objective 6). Debug logs are
// suppressed outside development unless explicitly enabled
// (NEXT_PUBLIC_AGENT_DEBUG="true"), so production never gets console
// spam. warn/error always log, so real problems are never silently
// swallowed.
//
// This is the ONLY file that calls console.* in the AI stack — every
// other module takes a Logger and calls logger.debug/warn/error, so
// swapping this for a real telemetry sink (Sentry, Datadog, a custom
// endpoint) later is a one-file change.
const DEBUG_ENABLED =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_AGENT_DEBUG === "true");

function withPrefix(level: LogLevel, message: string): string {
  return `[MPGR Agent:${level}] ${message}`;
}

export class ConsoleLogger implements Logger {
  debug(message: string, context?: LogContext): void {
    if (!DEBUG_ENABLED) return;
    // eslint-disable-next-line no-console
    console.debug(withPrefix("debug", message), context ?? "");
  }

  warn(message: string, context?: LogContext): void {
    // eslint-disable-next-line no-console
    console.warn(withPrefix("warn", message), context ?? "");
  }

  error(message: string, context?: LogContext): void {
    // eslint-disable-next-line no-console
    console.error(withPrefix("error", message), context ?? "");
  }
}

// Default singleton — sufficient for the local/mock phase. Swap by
// passing a different Logger into
// lib/architecture/ai/agent-ai-service-instance.ts; nothing else needs
// to change.
export const logger: Logger = new ConsoleLogger();
