// Isolated test entry, never a Next route. All controllers/session/wallet are
// deterministic doubles; actual review/launcher components and CSS are used.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentAutonomyDraftReview } from "@/components/features/agent/AgentAutonomyDraftReview";
import { AgentTradingLauncher } from "@/components/features/agent/AgentTradingLauncher";
import { CHAT_REVIEW_TOKENS, chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { reviewQuoteFixture } from "@/components/features/agent/test-fixtures/chat-review-quote";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import { WalletContext } from "./wallet";
import "@/app/globals.css";
const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
const parsed = buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt, { referencePrice: "347" });
const proposal = reviewQuoteFixture(chatDraftToForm(parsed));
const baseConfig = { enabled: true, emergencyDisabled: false, productionGate: true, executionAvailable: true,
  delegated: { chainId: 8453, executor: "0x1111111111111111111111111111111111111111", walletSigningSupported: true },
  limits: { maxGoalsPerWallet: 5, minCooldownSeconds: 60, maxPolicyTtlDays: 30, maxPerTradeHuman: "100", maxDailyHuman: "500", maxSlippageBps: 100 } };
function Audit() {
  const [draft, setDraft] = useState<typeof parsed | null>(null);
  const [scenario, setScenario] = useState("ready");
  const [authenticated, setAuthenticated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [calls, setCalls] = useState(0);
  const [manual, setManual] = useState(false);
  const [manualForm, setManualForm] = useState(false);
  const modal = new URLSearchParams(location.search).has("modal");
  const config = { ...baseConfig, delegated: { ...baseConfig.delegated } };
  if (scenario === "runtime") config.enabled = false;
  if (scenario === "production") config.productionGate = false;
  if (scenario === "adapter") config.executionAvailable = false;
  if (scenario === "emergency") config.emergencyDisabled = true;
  if (scenario === "delegated") config.delegated.chainId = 84532;
  const autonomy = {
    draft, config, tokens: CHAT_REVIEW_TOKENS, settingsRead: { state: scenario === "settings" ? "loading" : "loaded", httpStatus: 200, productionGate: scenario === "production" ? "missing" : "enabled" },
    busy, error: null, authenticated, authenticating: false, goals: [], policies: [], slots: [], manualFormOpen: manualForm,
    clearDraft: () => setDraft(null), dismissError: () => {}, refresh: async () => {},
    signIn: async () => { setAuthenticated(true); return true; },
    activateDraft: async () => {
      setCalls((n) => n + 1); setBusy(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      setBusy(false);
      if (scenario === "throw") throw new Error("Fixture transport failure");
      return scenario === "success" ? { ok: true, mode: "signed" } : { ok: false, message: "Fixture persistence failed; draft remains inactive. Retry safely." };
    },
    openManualForm: () => setManualForm(true), closeManualForm: () => setManualForm(false),
  };
  return <WalletContext.Provider value={{ address: scenario === "wallet-change" ? "0x3333333333333333333333333333333333333333" : "0x1111111111111111111111111111111111111111", isConnected: scenario !== "disconnected", chainId: scenario === "network" ? 1 : 8453 }}>
    <main className="mx-auto max-w-xl p-2 text-white">
      <p>Isolated fixtures — no live wallet/API/execution</p>
      <label>Fixture state <select aria-label="Fixture state" className="bg-surface" value={scenario} onChange={(e) => { setScenario(e.target.value); setAuthenticated(e.target.value !== "session"); }}>
        {["ready", "runtime", "production", "adapter", "delegated", "emergency", "settings", "disconnected", "network", "session", "throw", "success", "wallet-change"].map((v) => <option key={v}>{v}</option>)}
      </select></label>
      <button data-testid="open-review" className="m-2 min-h-[44px]" onClick={() => setDraft(parsed)}>Review parsed AAPLc draft</button>
      <p data-testid="activation-calls">{calls}</p>
      <div style={{ height: "65dvh" }} className="relative flex h-[65dvh] min-h-0 flex-col rounded-xl border border-white/10">
        <div data-testid="chat-scroll" className="relative min-h-0 flex-1 overflow-y-auto">
          <AgentAutonomyDraftReview autonomy={autonomy as never} embedded={!modal} />
        </div>
      </div>
      <AgentTradingLauncher autonomy={autonomy as never} connected onConnect={() => {}} proposals={[proposal]} onReviewTrade={() => setManual(true)} />
      {manual && <p data-testid="manual-review">Existing immediate proposal review handler</p>}
    </main>
  </WalletContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Audit />);
