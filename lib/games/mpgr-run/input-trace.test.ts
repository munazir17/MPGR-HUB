import { describe, expect, it } from "vitest";
import {
  appendRunInputEvent,
  cloneRunInputTrace,
  createRunInputTrace,
  MPGR_RUN_TRACE_VERSION,
} from "./input-trace";

describe("MPGR Run input trace", () => {
  it("creates a versioned empty trace", () => {
    expect(createRunInputTrace()).toEqual({
      version: MPGR_RUN_TRACE_VERSION,
      events: [],
    });
  });

  it("records accepted input events in order", () => {
    const trace = createRunInputTrace();

    appendRunInputEvent(trace, { type: "jump", atMs: 100 });
    appendRunInputEvent(trace, { type: "lane", atMs: 250, dir: 1 });
    appendRunInputEvent(trace, { type: "slide", atMs: 500 });

    expect(trace.events).toEqual([
      { type: "jump", atMs: 100 },
      { type: "lane", atMs: 250, dir: 1 },
      { type: "slide", atMs: 500 },
    ]);
  });

  it("allows multiple events at the same simulation time", () => {
    const trace = createRunInputTrace();

    appendRunInputEvent(trace, { type: "jump", atMs: 100 });
    appendRunInputEvent(trace, { type: "lane", atMs: 100, dir: 1 });

    expect(trace.events).toHaveLength(2);
  });

  it("rejects negative or non-finite timestamps", () => {
    const trace = createRunInputTrace();

    expect(() =>
      appendRunInputEvent(trace, { type: "jump", atMs: -1 }),
    ).toThrow();

    expect(() =>
      appendRunInputEvent(trace, { type: "jump", atMs: Number.NaN }),
    ).toThrow();

    expect(() =>
      appendRunInputEvent(trace, { type: "jump", atMs: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it("rejects out-of-order events", () => {
    const trace = createRunInputTrace();

    appendRunInputEvent(trace, { type: "jump", atMs: 200 });

    expect(() =>
      appendRunInputEvent(trace, { type: "slide", atMs: 199 }),
    ).toThrow();
  });

  it("rejects an invalid lane direction", () => {
    const trace = createRunInputTrace();

    expect(() =>
      appendRunInputEvent(
        trace,
        { type: "lane", atMs: 100, dir: 0 as -1 | 1 },
      ),
    ).toThrow();
  });

  it("clones without sharing the event array", () => {
    const trace = createRunInputTrace();

    appendRunInputEvent(trace, { type: "jump", atMs: 100 });

    const clone = cloneRunInputTrace(trace);

    expect(clone).toEqual(trace);
    expect(clone).not.toBe(trace);
    expect(clone.events).not.toBe(trace.events);
  });
});
