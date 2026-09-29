import type { CollectibleEntity, ObstacleEntity } from "./spawn-manager";
import { OBSTACLE_TYPES } from "./run-config";

/** Elevate only real authoritative coins. No spawns, RNG, IDs or reward changes.
 * World-locked height stays stable as the road scrolls; nearby jump obstacles
 * lift their existing reward path. Collection remains lane/depth based.
 */
export function collectiblePresentationHeight(coin: CollectibleEntity, traveled: number, obstacles: readonly ObstacleEntity[]): number {
  if (coin.type !== "coin") return coin.airHeight ?? 0;
  if (coin.airHeight !== undefined) return coin.airHeight;
  let height = 0;
  for (const obstacle of obstacles) {
    if (obstacle.lane !== coin.lane || OBSTACLE_TYPES[obstacle.type].avoidedBy !== "jump") continue;
    const distance = Math.abs(coin.x - (obstacle.x + obstacle.width / 2));
    if (distance < 180) height = Math.max(height, 68 * Math.sin(Math.PI * (1 - distance / 180) / 2));
  }
  // A broad, world-locked wave gives existing coins stepped airborne lines
  // even on clear road, without pretending there are new collectible arcs.
  const phase = ((coin.x + traveled) % 1100 + 1100) % 1100;
  return Math.max(height, phase > 300 && phase < 800 ? 54 * Math.sin((phase - 300) / 500 * Math.PI) : 0);
}
