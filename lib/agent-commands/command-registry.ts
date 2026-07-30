import type { SlashCommand } from "./types";

// Phase 3A.6 — Slash Command Registry.
//
// A small, dependency-free registry — deliberately shaped like
// lib/architecture/core/event-bus.ts's `on`/`off` pattern (register,
// return an unsubscribe/unregister function) for consistency with the
// rest of the AI stack, but this is NOT the EventBus and does not touch
// it. Commands are looked up by name or alias; list() powers the command
// palette's default (unfiltered) view.
export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliases = new Map<string, string>();

  register(command: SlashCommand): () => void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliases.set(alias, command.name);
    }
    return () => this.unregister(command.name);
  }

  unregister(name: string): void {
    const command = this.commands.get(name);
    if (!command) return;
    this.commands.delete(name);
    for (const alias of command.aliases ?? []) {
      this.aliases.delete(alias);
    }
  }

  get(nameOrAlias: string): SlashCommand | undefined {
    const normalized = nameOrAlias.toLowerCase();
    return this.commands.get(normalized) ?? this.commands.get(this.aliases.get(normalized) ?? "");
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }

  // Used by the command palette while the user is typing after "/".
  // Matches on command name, aliases, and description substring so
  // "/stake" and "/staking" both surface the staking command.
  search(query: string): SlashCommand[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter(
      (c) =>
        c.name.includes(q) ||
        (c.aliases ?? []).some((a) => a.includes(q)) ||
        c.description.toLowerCase().includes(q)
    );
  }
}

export const agentCommandRegistry = new CommandRegistry();
