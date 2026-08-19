"use client";

/**
 * TEMPORARY DIAGNOSTIC ONLY — safe to delete this file at any time.
 *
 * Read-only: walks up the DOM from the live <canvas> element and reads
 * getBoundingClientRect() + getComputedStyle(). Does NOT touch resize(),
 * ResizeObserver, canvas.width/height, game state, controls, or rendering.
 */

import { useEffect, useState } from "react";

interface Row {
  label: string;
  rectHeight: string;
  rectWidth: string;
  cssHeight: string;
  cssMinHeight: string;
  cssFlex: string;
}

export function DebugOverlay() {
  const [rows, setRows] = useState<Row[]>([]);
  const [canvasCssW, setCanvasCssW] = useState("");
  const [canvasCssH, setCanvasCssH] = useState("");
  const [canvasBufW, setCanvasBufW] = useState("");
  const [canvasBufH, setCanvasBufH] = useState("");

  useEffect(() => {
    const measure = () => {
      const canvas = document.querySelector("canvas");
      if (!canvas) {
        setRows([{ label: "canvas: NOT FOUND", rectHeight: "", rectWidth: "", cssHeight: "", cssMinHeight: "", cssFlex: "" }]);
        return;
      }

      const containerRef = canvas.parentElement; // containerRef
      const glassInner = containerRef?.parentElement ?? null; // GlassCard inner wrapper
      const glassOuter = glassInner?.parentElement ?? null; // GlassCard outer motion.div
      const runRoot = glassOuter?.parentElement ?? null; // RunGame root
      const motionWrap = runRoot?.parentElement ?? null; // page.tsx motion.div
      const main = motionWrap?.closest("main") ?? null;

      const nodes: [string, Element | null][] = [
        ["main", main],
        ["RunGame root", runRoot],
        ["GlassCard outer", glassOuter],
        ["GlassCard inner", glassInner],
        ["containerRef", containerRef],
      ];

      const results: Row[] = nodes.map(([label, el]) => {
        if (!el) return { label, rectHeight: "null", rectWidth: "", cssHeight: "", cssMinHeight: "", cssFlex: "" };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          label,
          rectHeight: r.height.toFixed(1),
          rectWidth: r.width.toFixed(1),
          cssHeight: cs.height,
          cssMinHeight: cs.minHeight,
          cssFlex: cs.flex,
        };
      });

      const canvasRect = canvas.getBoundingClientRect();
      setCanvasCssW(canvasRect.width.toFixed(1));
      setCanvasCssH(canvasRect.height.toFixed(1));
      setCanvasBufW(String(canvas.width));
      setCanvasBufH(String(canvas.height));

      setRows(results);
    };

    measure();
    const interval = setInterval(measure, 500);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 99999,
        background: "rgba(0,0,0,0.92)",
        color: "#0f0",
        fontSize: "9px",
        lineHeight: "1.35",
        fontFamily: "monospace",
        padding: "6px",
        maxWidth: "100vw",
        pointerEvents: "none",
        whiteSpace: "pre",
      }}
    >
      {rows.map((r) => (
        <div key={r.label}>
          {r.label.padEnd(16)} rect-h={r.rectHeight.padEnd(7)} rect-w={r.rectWidth.padEnd(7)} css-h={r.cssHeight.padEnd(9)} min-h={r.cssMinHeight.padEnd(9)} flex={r.cssFlex}
        </div>
      ))}
      <div>canvas CSS w x h: {canvasCssW} x {canvasCssH}</div>
      <div>canvas buffer w x h: {canvasBufW} x {canvasBufH}</div>
    </div>
  );
}

