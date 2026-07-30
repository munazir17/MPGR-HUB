import type { ParsedCommand } from "./types";

// Phase 3A.6 — Slash Command Parser.
//
// Deliberately minimal: a leading "/", a command name, and whitespace-
// separated args. No quoting, no flags — matches the actual command set
// in commands.ts, all of which take at most one plain-text argument
// (e.g. "/token mpgr"). Extend this only if a future command genuinely
// needs richer syntax.

export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const [name, ...args] = parts;
  return { raw: trimmed, name: name.toLowerCase(), args };
}
