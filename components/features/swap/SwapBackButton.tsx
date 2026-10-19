"use client";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { hasUsefulSwapHistory } from "@/lib/swap/swap-navigation";
type NavigationMetadata = { currentEntry?: { index: number }; entries: () => { url?: string }[] };
export function SwapBackButton({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const goBack = () => {
    let previous: string | null | undefined;
    try {
      const navigation = (window as Window & { navigation?: NavigationMetadata }).navigation;
      if (navigation) previous = navigation.entries()[(navigation.currentEntry?.index ?? 0) - 1]?.url ?? null;
    } catch { previous = null; }
    if (hasUsefulSwapHistory(window.location.href, previous, document.referrer, window.history.length)) router.back();
    else router.replace("/"); // MPGR HUB dashboard; never back to an external site.
  };
  return <button type="button" aria-label="Go back" title="Go back" onClick={goBack} disabled={disabled}
    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-emerald-300 disabled:opacity-40"><ArrowLeft size={20} /></button>;
}
