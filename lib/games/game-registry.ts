// lib/games/game-registry.ts
//
// Single source of truth for every game on the MPGR HUB Games roadmap.
// The Games Hub (app/games/page.tsx) and each game's own route read from
// this registry — nothing hardcodes game metadata anywhere else.
//
// To add a future game: add one GameDefinition entry here with
// status: "coming_soon", then flip it to "playable" once its route ships.
// Nothing else in the platform layer needs to change.

import type { GameDefinition, GameId } from "./game-types";

export const GAME_REGISTRY: GameDefinition[] = [
  {
    id: "mpgr-run",
    slug: "mpgr-run",
    name: "MPGR Run",
    tagline: "How far can you run?",
    description:
      "One-tap endless runner. Jump obstacles, collect coins, and survive as long as you can.",
    category: "arcade",
    difficulty: "easy",
    estimatedPlayTime: "30s–3min",
    status: "playable",
    icon: "🦖",
    iconImage: "/games/mpgr-run/character/mpgr-runner-idle.png",
    accentGradient: "from-primary-glow/25 to-primary/10",
    route: "/games/mpgr-run",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
    featured: true,
  },
  {
    id: "mpgr-clicker",
    slug: "mpgr-clicker",
    name: "MPGR Clicker",
    tagline: "Tap, upgrade, repeat.",
    description:
      "Idle clicker with upgrades and passive production — daily progression loop.",
    category: "casual",
    difficulty: "easy",
    estimatedPlayTime: "Ongoing",
    status: "coming_soon",
    icon: "👆",
    accentGradient: "from-gold-glow/25 to-gold/10",
    route: "/games/mpgr-clicker",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "memory-challenge",
    slug: "memory-challenge",
    name: "Memory Challenge",
    tagline: "Match fast. Think faster.",
    description: "Card-matching memory game against the clock.",
    category: "puzzle",
    difficulty: "medium",
    estimatedPlayTime: "1–2min",
    status: "coming_soon",
    icon: "🧠",
    accentGradient: "from-primary-glow/25 to-primary/10",
    route: "/games/memory-challenge",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "space-shooter",
    slug: "space-shooter",
    name: "Space Shooter",
    tagline: "Waves. Powerups. Chaos.",
    description:
      "Arcade shooter with enemy waves, projectiles, and powerups.",
    category: "arcade",
    difficulty: "hard",
    estimatedPlayTime: "2–5min",
    status: "coming_soon",
    icon: "🚀",
    accentGradient: "from-primary-glow/25 to-primary/10",
    route: "/games/space-shooter",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "2048-daily",
    slug: "2048-daily",
    name: "2048 Daily Puzzle",
    tagline: "One board. One shot. Every day.",
    description:
      "Daily-seeded 2048 puzzle — same board for everyone, once a day.",
    category: "puzzle",
    difficulty: "medium",
    estimatedPlayTime: "3–8min",
    status: "coming_soon",
    icon: "🧩",
    accentGradient: "from-gold-glow/25 to-gold/10",
    route: "/games/2048-daily",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "pet-raising",
    slug: "pet-raising",
    name: "Pet Raising",
    tagline: "Raise your MPGR companion.",
    description: "Persistent pet with feeding, leveling, and battles.",
    category: "casual",
    difficulty: "easy",
    estimatedPlayTime: "Ongoing",
    status: "coming_soon",
    icon: "🐱",
    accentGradient: "from-gold-glow/25 to-gold/10",
    route: "/games/pet-raising",
    supportsLeaderboard: false,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "speed-run",
    slug: "speed-run",
    name: "Speed Run",
    tagline: "Every second counts.",
    description: "Time-trial competitive mode with verified timing.",
    category: "competitive",
    difficulty: "hard",
    estimatedPlayTime: "1–3min",
    status: "coming_soon",
    icon: "⚡",
    accentGradient: "from-primary-glow/25 to-primary/10",
    route: "/games/speed-run",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "roguelike-rpg",
    slug: "roguelike-rpg",
    name: "Roguelike RPG",
    tagline: "Every run is different.",
    description:
      "Procedural combat, inventory, and progression run-to-run.",
    category: "rpg",
    difficulty: "extreme",
    estimatedPlayTime: "5–15min",
    status: "coming_soon",
    icon: "⚔️",
    accentGradient: "from-primary-glow/25 to-primary/10",
    route: "/games/roguelike-rpg",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
  {
    id: "ai-battle-arena",
    slug: "ai-battle-arena",
    name: "AI Battle Arena",
    tagline: "Outsmart the machine.",
    description: "Strategic battles against AI opponents.",
    category: "strategy",
    difficulty: "extreme",
    estimatedPlayTime: "3–10min",
    status: "coming_soon",
    icon: "🤖",
    accentGradient: "from-gold-glow/25 to-gold/10",
    route: "/games/ai-battle-arena",
    supportsLeaderboard: true,
    supportsXP: true,
    supportsSeasonPoints: true,
  },
];

export function getGameDefinition(
  id: GameId
): GameDefinition | undefined {
  return GAME_REGISTRY.find((g) => g.id === id);
}

export function getFeaturedGame(): GameDefinition {
  return GAME_REGISTRY.find((g) => g.featured) ?? GAME_REGISTRY[0];
}

export function getPlayableGames(): GameDefinition[] {
  return GAME_REGISTRY.filter((g) => g.status === "playable");
}
