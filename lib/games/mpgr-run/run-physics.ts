import {
  LANE_CENTER_Y,
  LANE_GAP_PX,
  PLAYER_SIZE,
  SLIDE_HITBOX_SCALE,
} from "./run-config";
import type { ObstacleEntity } from "./spawn-manager";

export interface PhysicsPlayer {
  sliding: boolean;
  playerY: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function laneBaselineScreenY(canvasHeight: number, lane: number): number {
  return canvasHeight * LANE_CENTER_Y + (lane - 1) * LANE_GAP_PX;
}

/** Vertical hazard-band overlap. tnt/barrier have no vertical escape. */
export function verticalOverlap(o: ObstacleEntity, p: PhysicsPlayer): boolean {
  if (o.type === "tnt" || o.type === "barrier") return true;
  const playerHeight = p.sliding ? PLAYER_SIZE * SLIDE_HITBOX_SCALE : PLAYER_SIZE;
  const playerBottom = p.playerY;
  const playerTop = playerBottom + playerHeight;
  const obstacleBottom = o.groundHeight;
  const obstacleTop = o.groundHeight + o.height;
  return playerTop > obstacleBottom && playerBottom < obstacleTop;
}
