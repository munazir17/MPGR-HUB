"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
export function SwapDialog({ title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return createPortal(<dialog ref={ref} aria-labelledby={titleId} aria-busy={busy}
    onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}
    className="m-auto max-h-[88dvh] w-[calc(100%-24px)] max-w-md overflow-y-auto overscroll-contain rounded-3xl border border-white/10 bg-[#10151f] p-0 text-white shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm">
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-[#10151f] px-5 py-3">
      <h2 id={titleId} className="text-base font-semibold">{title}</h2>
      <button type="button" aria-label={`Close ${title}`} onClick={onClose} disabled={busy} className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-400 hover:bg-white/5 disabled:opacity-40"><X size={18} /></button>
    </header><div className="space-y-4 p-5">{children}</div>
  </dialog>, document.body);
}
