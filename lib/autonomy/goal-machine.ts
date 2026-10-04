// lib/autonomy/goal-machine.ts
//
// Goal lifecycle enforcement (spec §8). The store refuses any update that
// would move a goal through an invalid transition — callers can never coerce
// state (e.g. a paused goal cannot execute; a terminal goal cannot revive).

import { canTransitionGoal, isTerminalGoalStatus, type AgentGoal, type GoalStatus } from "./types";

export class InvalidGoalTransitionError extends Error {
  constructor(readonly from: GoalStatus, readonly to: GoalStatus) {
    super(`Invalid goal transition: ${from} -> ${to}`);
    this.name = "InvalidGoalTransitionError";
  }
}

export function requireTransition(from: GoalStatus, to: GoalStatus): void {
  if (from === to) return; // no-op status writes are allowed (field updates)
  if (!canTransitionGoal(from, to)) throw new InvalidGoalTransitionError(from, to);
}

/** Goals the scheduler may evaluate. */
export function isEvaluatable(goal: AgentGoal): boolean {
  return goal.status === "ACTIVE" || goal.status === "WAITING";
}

export function isTerminal(goal: AgentGoal): boolean {
  return isTerminalGoalStatus(goal.status);
}
