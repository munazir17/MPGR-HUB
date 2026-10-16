// Actual controllers, auth provider, launcher, confirmation and draft review.
// Only network responses (Playwright) and wallet transport (Vite aliases) are doubles.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgentAutonomy } from "@/hooks/useAgentAutonomy";
import { useTradeQuote } from "@/hooks/useTradeQuote";
import { WalletAuthProvider } from "@/hooks/useWalletAuth";
import { SwapExperience } from "@/components/features/swap/SwapExperience";
import { AgentTradingLauncher } from "@/components/features/agent/AgentTradingLauncher";
import { AgentTradeConfirmationModal } from "@/components/features/agent/AgentTradeConfirmationModal";
import { AgentAutonomyDraftReview } from "@/components/features/agent/AgentAutonomyDraftReview";
import { WalletContext, useAccount } from "./wallet";
import "@/app/globals.css";
function Controllers() {
  const { isConnected } = useAccount();
  const autonomy = useAgentAutonomy();
  const trade = useTradeQuote();
  return <><SwapExperience />
    <AgentTradingLauncher autonomy={autonomy} connected={isConnected} onConnect={() => {}} proposals={[]} onReviewTrade={trade.openProposal} />
    <div className="h-[70dvh] overflow-y-auto"><AgentAutonomyDraftReview autonomy={autonomy} embedded /></div>
    <AgentTradeConfirmationModal {...trade} onClose={trade.close} onConfirmAndSwap={trade.confirmAndSwap} />
    <p data-testid="flow-state">{trade.executionState}</p><p data-testid="flow-auth">{String(autonomy.authenticated)}</p>
  </>;
}
function Flows() {
  const [scenario, setScenario] = useState("connected");
  return <WalletContext.Provider value={{ address: scenario === "other-wallet" ? "0x3333333333333333333333333333333333333333" : "0x1111111111111111111111111111111111111111", isConnected: scenario !== "disconnected", chainId: scenario === "wrong-network" ? 1 : 8453 }}>
    <WalletAuthProvider><main className="mx-auto max-w-xl p-2 text-white"><p>Simulated flows — no real wallet, network execution or settlement</p>
      <label>Wallet fixture<select aria-label="Wallet fixture" value={scenario} onChange={e => setScenario(e.target.value)} className="bg-surface">{["connected", "wrong-network", "disconnected", "other-wallet"].map(s => <option key={s}>{s}</option>)}</select></label>
      <Controllers />
    </main></WalletAuthProvider>
  </WalletContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Flows />);
