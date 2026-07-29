"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import {
  appendAssistantReply,
  appendUserMessage,
  clearAgentState,
  getAgentState,
  type AgentMessage,
} from "@/lib/agent-engine";

// Simulated "thinking" delay so the mock reply doesn't appear instantly —
// purely a local UX beat, not a network call.
const THINKING_DELAY_MIN_MS = 600;
const THINKING_DELAY_MAX_MS = 1400;

export function useAgentChat() {
  const { address, isConnected } = useAccount();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    setMessages(getAgentState(address).messages);
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setMessages([]);
      setThinking(false);
      setHasLoaded(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Clear any pending "thinking" timeout on unmount or address change so we
  // never call setState after the component/wallet has moved on.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [address]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!address) return;
      const trimmed = content.trim();
      if (!trimmed || thinking) return;

      const afterUser = appendUserMessage(address, trimmed);
      setMessages(afterUser.messages);
      setThinking(true);

      const delay = THINKING_DELAY_MIN_MS + Math.random() * (THINKING_DELAY_MAX_MS - THINKING_DELAY_MIN_MS);
      timeoutRef.current = setTimeout(() => {
        const afterAssistant = appendAssistantReply(address, trimmed);
        setMessages(afterAssistant.messages);
        setThinking(false);
      }, delay);
    },
    [address, thinking]
  );

  const clearChat = useCallback(() => {
    if (!address) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setThinking(false);
    const cleared = clearAgentState(address);
    setMessages(cleared.messages);
  }, [address]);

  return {
    messages,
    thinking,
    isConnected,
    hasLoaded,
    sendMessage,
    clearChat,
  };
}
