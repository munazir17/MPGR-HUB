import type { Logger, Task, TaskPriority, TaskQueue } from "./types";
import { logger as defaultLogger } from "./logger";

function makeTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Phase 3A.5 — sequential, in-memory background task queue (objective 4).
// No backend required: runs entirely client-side, processes one task at a
// time in FIFO order, and keeps a small history so a caller can poll a
// task's status/result.
//
// Nothing in the current Agent feature enqueues real work yet — this is
// architecture ahead of need, ready for: memory summarization, memory
// ranking, portfolio refresh, trading analysis, knowledge indexing. Those
// future jobs just call `.enqueue(label, work)`; this file doesn't need
// to change for them.
//
// Phase 3A.5 (final) — priority lanes. Three FIFO lanes (high/normal/low)
// instead of one; drain() always exhausts "high" before touching
// "normal", and "normal" before "low". Every existing enqueue(label, work)
// call site is unaffected: the third argument defaults to "normal", which
// is the only lane that existed before this change, so a queue with only
// normal-priority work drains in exactly the same order as today.
//
// Production audit addendum — `tasks` used to grow without bound: every
// enqueue() added a permanent entry, and nothing ever removed one, even
// long after a task finished. In practice almost every chat turn now
// enqueues at least one low-priority memory task (see
// lib/architecture/ai/agent-ai-service.ts), so a long-lived session kept
// accumulating finished Task objects for as long as the tab stayed open —
// an unbounded, if slow, memory leak. Fixed the same way
// lib/architecture/core/performance-monitor.ts already bounds its own
// metrics array (MAX_METRICS + shift()): finished tasks (done or failed)
// are now tracked in a small FIFO of their own, and once that FIFO
// exceeds MAX_FINISHED_TASKS the oldest finished task is evicted from
// `tasks`. Pending/running tasks are never evicted — only tasks that have
// already reached a terminal state and been recorded via getTask()'s
// public shape. getTasks()/getTask() behavior for anything still
// in-flight, or finished within the retention window, is unchanged;
// callers polling a task's result should already do so promptly (this
// was always an in-memory, non-persistent history, per the file's own
// header above), which the existing codebase already does everywhere it
// enqueues.
const MAX_FINISHED_TASKS = 200;

export class InMemoryTaskQueue implements TaskQueue {
  private tasks = new Map<string, Task>();
  private finishedOrder: string[] = [];
  private lanes: Record<TaskPriority, Array<{ id: string; work: () => Promise<unknown> }>> = {
    high: [],
    normal: [],
    low: [],
  };
  private draining = false;

  constructor(private readonly logger: Logger = defaultLogger) {}

  enqueue<T>(label: string, work: () => Promise<T>, priority: TaskPriority = "normal"): string {
    const id = makeTaskId();
    const task: Task<T> = {
      id,
      label,
      status: "pending",
      createdAt: new Date().toISOString(),
      priority,
    };
    this.tasks.set(id, task as Task);
    this.lanes[priority].push({ id, work: work as () => Promise<unknown> });
    this.logger.debug(`Task queued: ${label}`, { id, priority });
    void this.drain();
    return id;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getTasks(): Task[] {
    return [...this.tasks.values()];
  }

  // Pulls the next item across lanes in priority order (high, then
  // normal, then low), FIFO within whichever lane it comes from.
  private takeNext(): { id: string; work: () => Promise<unknown> } | undefined {
    return this.lanes.high.shift() ?? this.lanes.normal.shift() ?? this.lanes.low.shift();
  }

  // Records that a task reached a terminal state (done/failed) and
  // evicts the oldest finished task once the retention window is
  // exceeded. Only ever removes tasks already recorded here — pending or
  // running tasks are never touched.
  private markFinished(id: string): void {
    this.finishedOrder.push(id);
    if (this.finishedOrder.length > MAX_FINISHED_TASKS) {
      const oldest = this.finishedOrder.shift();
      if (oldest) this.tasks.delete(oldest);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let next = this.takeNext();
      while (next) {
        const task = this.tasks.get(next.id);
        if (task) task.status = "running";
        try {
          const result = await next.work();
          if (task) {
            task.status = "done";
            task.result = result;
          }
        } catch (err) {
          if (task) {
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
          }
          this.logger.error(`Task failed: ${next.id}`, { error: err });
        }
        this.markFinished(next.id);
        next = this.takeNext();
      }
    } finally {
      this.draining = false;
    }
  }
}

export const agentTaskQueue: TaskQueue = new InMemoryTaskQueue();
