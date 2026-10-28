---
name: mpgr-agent
description: Use the in-app MPGR Agent to buy or sell by text or microphone. Speech is transcribed by the server-side NVIDIA model and sent as a normal chat message. The wallet still confirms. Nothing is traded by the mic itself.
metadata:
  version: "2.0"
  author: munazir17
license: All Rights Reserved
---

# MPGR Agent

## Overview

The agent composer already turns a sentence into a quote and a wallet confirmation. The mic is another way to produce that sentence. This skill does not add a second execution engine.

## Voice

1. The user must connect a wallet. The mic stays off until then.
2. They tap the mic and say a buy or sell, for example "buy 10 USDC of AAPLc" or "sell MPGR for ETH". Recording stops at 8 seconds.
3. The browser posts the clip to `POST /api/agent/voice` with the session cookie.
4. The server sends it to NVIDIA speech (`nvidia/parakeet-ctc-1.1b-asr` unless `NVIDIA_ASR_MODEL` is set) using `NVIDIA_API_KEY`. The key never goes to the browser.
5. The transcript is delivered to the existing `onSend` path. The same confirmation the typed message uses still applies.
6. If NVIDIA is not configured or the clip cannot be transcribed, the browser speech transcript is used only as a fallback. If that is also empty, nothing is traded.

## Rules

- Do not sign, approve, or broadcast because a transcript arrived.
- Do not put `NVIDIA_API_KEY` in any `NEXT_PUBLIC_` variable or in a log line.
- A spoken "yes" is not a wallet signature.
- Keep the orbital lines on the agent orb as a faint guide, not a solid ring. The stock tape runs at half the previous speed (`96s` / `64s`).
- Limit orders stay unavailable until that feature ships. Do not render a dead "not available" control.
