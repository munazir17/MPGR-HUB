"use client";

import { Component, type ReactNode } from "react";
import { AlertOctagon, RotateCcw } from "lucide-react";
import { logger } from "@/lib/architecture/core/logger";

interface AgentErrorBoundaryProps {
  children: ReactNode;
}

interface AgentErrorBoundaryState {
  hasError: boolean;
}

// Phase 3A.5 — objective 8: one AI component crashing must never take
// down the whole Agent page. React error boundaries must be class
// components — this is the one deliberate exception to the rest of the
// Agent feature's function-component convention.
//
// Deliberately narrow: this only catches render/lifecycle errors thrown
// by its children (React's error boundary semantics). It does NOT catch
// errors from async code in hooks/useAgentChat.ts or
// lib/architecture/ai/agent-ai-service.ts, which already have their own
// try/catch -> `error` state (see AgentErrorBanner.tsx). The two are
// complementary: AgentErrorBanner handles "generation failed", this
// handles "a component crashed while rendering".
export class AgentErrorBoundary extends Component<AgentErrorBoundaryProps, AgentErrorBoundaryState> {
  state: AgentErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AgentErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    logger.error("Agent UI crashed", { error: error.message, componentStack: info.componentStack });
  }

  private handleReset = (): void => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-[420px] flex-col items-center justify-center gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6 text-center backdrop-blur-xl sm:h-[600px]">
          <AlertOctagon className="h-8 w-8 text-red-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-white">Something went wrong</p>
            <p className="mt-1 max-w-xs text-xs text-muted">
              The MPGR Agent hit an unexpected error. Your conversation history is safe.
            </p>
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-white/[0.06]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
