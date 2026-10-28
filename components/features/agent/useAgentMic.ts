"use client";

// Mic for the MPGR Agent. NVIDIA Parakeet (server) is preferred. The
// browser speech engine is only a fallback when that key is not set, so
// "buy AAPLc" / "sell MPGR" still reaches the existing confirm flow.
// This hook never signs or broadcasts.

import { useRef, useState } from "react";

interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface BrowserSpeech {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function browserSpeech(): { new (): BrowserSpeech } | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & { SpeechRecognition?: new () => BrowserSpeech; webkitSpeechRecognition?: new () => BrowserSpeech };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

async function nvidiaTranscript(blob: Blob): Promise<string | null> {
  const body = new FormData();
  body.set("audio", blob, "speech.webm");
  const response = await fetch("/api/agent/voice", { method: "POST", credentials: "include", body });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as { transcript?: unknown } | null;
  return typeof payload?.transcript === "string" && payload.transcript.trim() ? payload.transcript.trim() : null;
}

export function useAgentMic(onHeard: (transcript: string) => void) {
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const speech = useRef<BrowserSpeech | null>(null);
  const session = useRef(0);
  const browserText = useRef("");

  const start = async () => {
    if (listening) {
      if (recorder.current && recorder.current.state !== "inactive") {
        recorder.current.stop();
        return;
      }
      session.current += 1;
      try { speech.current?.stop(); } catch { /* already stopped */ }
      setListening(false);
      const text = browserText.current.trim();
      if (text) {
        setStatus(null);
        onHeard(text);
      }
      return;
    }

    const id = ++session.current;
    browserText.current = "";
    setStatus("Listening… say buy or sell.");
    const Speech = browserSpeech();
    if (Speech) {
      const engine = new Speech();
      engine.lang = "en-IN";
      engine.interimResults = false;
      engine.maxAlternatives = 1;
      engine.onresult = (event) => {
        browserText.current = event.results[0]?.[0]?.transcript?.trim() ?? browserText.current;
      };
      engine.onerror = () => undefined;
      speech.current = engine;
      try { engine.start(); } catch { /* permission is requested below */ }
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!speech.current) {
        setListening(false);
        setStatus("Microphone permission is needed. Nothing was traded.");
        return;
      }
      setListening(true);
      window.setTimeout(() => {
        if (session.current !== id) return;
        try { speech.current?.stop(); } catch { /* already stopped */ }
        setListening(false);
        const text = browserText.current.trim();
        if (text) {
          setStatus(null);
          onHeard(text);
        } else setStatus("Couldn't hear that. Try again. Nothing was traded.");
      }, 8000);
      return;
    }

    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    recorder.current = rec;
    rec.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      try { speech.current?.stop(); } catch { /* already stopped */ }
      if (session.current !== id) return;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      void (async () => {
        const fromNvidia = blob.size >= 80 ? await nvidiaTranscript(blob).catch(() => null) : null;
        const transcript = fromNvidia || browserText.current.trim();
        setListening(false);
        if (transcript) {
          setStatus(null);
          onHeard(transcript);
        } else setStatus("Couldn't hear that. Try again. Nothing was traded.");
      })();
    };
    rec.start();
    setListening(true);
    window.setTimeout(() => {
      if (session.current === id && recorder.current === rec && rec.state === "recording") rec.stop();
    }, 8000);
  };

  return { listening, status, start };
}
