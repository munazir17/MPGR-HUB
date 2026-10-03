/** Presentation-only painter queue. Reuses entries after warm-up, rather
 * than allocating an object and capturing a drawing closure for every item
 * on every frame. No world/entity references survive a frame. */
export interface RunDrawEntry {
  z: number;
  kind: number;
  index: number;
  scale: number;
  a: number;
  b: number;
  c: number;
  order: number;
}

const depthOrder = (a: RunDrawEntry, b: RunDrawEntry) => (b.z - a.z) || (a.order - b.order);

export class RunDrawQueue {
  readonly entries: RunDrawEntry[] = [];
  count = 0;

  begin() { this.count = 0; }

  add(z: number, kind: number, index: number, scale: number, a = 0, b = 0, c = 0) {
    const order = this.count++;
    let entry = this.entries[order];
    if (!entry) {
      entry = { z, kind, index, scale, a, b, c, order };
      this.entries.push(entry);
    } else {
      entry.z = z; entry.kind = kind; entry.index = index; entry.scale = scale;
      entry.a = a; entry.b = b; entry.c = c; entry.order = order;
    }
  }

  sort() {
    // Keep spare entries for reuse without drawing stale entities. Equal
    // depths retain this frame's insertion order (same painter semantics).
    for (let i = this.count; i < this.entries.length; i++) this.entries[i].z = -Infinity;
    this.entries.sort(depthOrder);
  }
}

const queues = new WeakMap<CanvasRenderingContext2D, RunDrawQueue>();
export function runDrawQueue(ctx: CanvasRenderingContext2D): RunDrawQueue {
  let queue = queues.get(ctx);
  if (!queue) { queue = new RunDrawQueue(); queues.set(ctx, queue); }
  queue.begin();
  return queue;
}
