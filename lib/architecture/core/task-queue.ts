import type { Logger, Task, TaskQueue } from "./types";
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
export class InMemoryTaskQueue implements TaskQueue {
  private tasks = new Map<string, Task>();
  private queue: Array<{ id: string; work: () => Promise<unknown> }> = [];
  private draining = false;

  constructor(private readonly logger: Logger = defaultLogger) {}

  enqueue<T>(label: string, work: () => Promise<T>): string {
    const id = makeTaskId();
    const task: Task<T> = { id, label, status: "pending", createdAt: new Date().toISOString() };
    this.tasks.set(id, task as Task);
    this.queue.push({ id, work: work as () => Promise<unknown> });
    this.logger.debug(`Task queued: ${label}`, { id });
    void this.drain();
    return id;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getTasks(): Task[] {
    return [...this.tasks.values()];
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let next = this.queue.shift();
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
        next = this.queue.shift();
      }
    } finally {
      this.draining = false;
    }
  }
}

export const agentTaskQueue: TaskQueue = new InMemoryTaskQueue();
