// History provenance is navigation metadata only, never wallet/auth state.
// null means the Navigation API is present but has no prior readable entry;
// undefined means unavailable, in which case a same-origin referrer may help.
export function hasUsefulSwapHistory(currentURL: string, previousURL: string | null | undefined, referrer: string, historyLength: number): boolean {
  if (historyLength <= 1) return false;
  const candidate = previousURL === undefined ? referrer : previousURL;
  if (!candidate) return false;
  try {
    const current = new URL(currentURL), previous = new URL(candidate);
    return ["http:", "https:"].includes(previous.protocol) && previous.protocol === current.protocol
      && previous.origin === current.origin && !/^\/(api|_next|tokens)(\/|$)/.test(previous.pathname)
      && previous.pathname.replace(/\/+$/, "") !== current.pathname.replace(/\/+$/, "");
  } catch { return false; }
}
