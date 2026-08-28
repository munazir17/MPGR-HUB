// lib/architecture/tools/x402-tool-definitions.ts
//
// P3 — x402 Agentic Commerce, agent-facing tools.
//
// Exactly two tools, both well inside AgentToolRuntime's existing
// read/prepare safety envelope (see agent-tool-runtime.ts's header
// comment — "execute" tools are unconditionally refused there; there is
// no third tool here that tries to be one):
//
//   x402_discover_resource  (mode: "read")    — GETs a URL, reports
//     whether it requires x402 payment and what the accepted payment
//     options are. No proposal, no amount commitment, no side effects
//     beyond the read itself.
//
//   x402_prepare_payment    (mode: "prepare") — builds a structured,
//     typed X402PaymentProposal (lib/x402/x402-proposal.ts) for ONE
//     already-discovered requirement. Returns a proposal for the UI to
//     render and the user to explicitly confirm — it does not sign
//     anything, does not call the wallet, and does not submit the paid
//     request. See hooks/useX402Payment.ts for the confirm -> sign ->
//     submit -> verify path that picks up this tool's output.
//
// The LLM can select which of these to call and which resource/index to
// pass, but it can never reach signing/submission through this
// registry — that boundary is enforced structurally (no "execute" tool
// exists here at all), not by a runtime permission check that could be
// misconfigured.

import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";
import { buildX402PaymentProposal } from "@/lib/x402/x402-proposal";

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";

// =============================================================================
// 1. x402_discover_resource
// =============================================================================

const discoverSchema: AgentToolSchema = {
  type: "object",
  properties: {
    resourceUrl: {
      type: "string",
      description: "The full https:// URL of the resource to check for an x402 payment requirement.",
    },
  },
  required: ["resourceUrl"],
};

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const x402DiscoverResourceTool: AgentTool = {
  id: "x402_discover_resource",
  name: "x402 Resource Discovery",
  description:
    "Checks whether a URL requires an x402 payment to access, and if so, reports the accepted payment options (asset, network, amount, recipient) exactly as the resource server declared them. Does not pay anything and does not commit to any amount.",
  category: "payment",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: discoverSchema,

  async execute(input) {
    const { resourceUrl } = (input ?? {}) as { resourceUrl?: unknown };

    if (!isHttpsUrl(resourceUrl)) {
      return toolError("x402_discover_resource", {
        code: "INVALID_INPUT",
        message: "resourceUrl must be a valid https:// URL.",
      });
    }

    let response: Response;
    try {
      response = await fetch(resourceUrl, { method: "GET" });
    } catch {
      return toolError("x402_discover_resource", {
        code: "PROVIDER_ERROR",
        message: "Could not reach that resource. This may be temporary.",
        retryable: true,
      });
    }

    if (response.status !== 402) {
      return toolSuccess("x402_discover_resource", {
        resourceUrl,
        paymentRequired: false,
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return toolError("x402_discover_resource", {
        code: "DATA_UNAVAILABLE",
        message: "This resource returned 402 but its response body was not valid JSON.",
      });
    }

    const parsed = parseX402PaymentRequired(body);
    if (!parsed.ok) {
      return toolError("x402_discover_resource", {
        code: "DATA_UNAVAILABLE",
        message: parsed.error.message,
      });
    }

    return toolSuccess("x402_discover_resource", {
      resourceUrl,
      paymentRequired: true,
      x402Version: parsed.x402Version,
      options: parsed.requirements.map((r, index) => ({
        index,
        scheme: r.requirement.scheme,
        network: r.requirement.network,
        asset: r.requirement.asset,
        maxAmountRequired: r.requirement.maxAmountRequired,
        payTo: r.requirement.payTo,
        description: r.requirement.description,
      })),
    });
  },
};

// =============================================================================
// 2. x402_prepare_payment
// =============================================================================

const preparePaymentSchema: AgentToolSchema = {
  type: "object",
  properties: {
    resourceUrl: {
      type: "string",
      description: "The same https:// URL previously discovered with x402_discover_resource.",
    },
    optionIndex: {
      type: "number",
      description: "Which of x402_discover_resource's returned `options[]` to prepare a payment for. Defaults to 0 if there is exactly one option.",
    },
  },
  required: ["resourceUrl"],
};

export const x402PreparePaymentTool: AgentTool = {
  id: "x402_prepare_payment",
  name: "x402 Payment Proposal",
  description:
    "Builds a structured payment proposal (amount, asset, network, recipient, what happens next) for a previously-discovered x402 resource. Returns a proposal for explicit user confirmation — this tool never signs a payment, never touches a wallet, and never submits a paid request.",
  category: "payment",
  mode: "prepare",
  riskLevel: "medium",
  requiresWallet: false,
  requiresConfirmation: true,
  inputSchema: preparePaymentSchema,

  async execute(input) {
    const { resourceUrl, optionIndex } = (input ?? {}) as { resourceUrl?: unknown; optionIndex?: unknown };

    if (!isHttpsUrl(resourceUrl)) {
      return toolError("x402_prepare_payment", {
        code: "INVALID_INPUT",
        message: "resourceUrl must be a valid https:// URL.",
      });
    }
    if (optionIndex !== undefined && (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0)) {
      return toolError("x402_prepare_payment", {
        code: "INVALID_INPUT",
        message: "optionIndex, if provided, must be a non-negative integer.",
      });
    }

    let response: Response;
    try {
      response = await fetch(resourceUrl, { method: "GET" });
    } catch {
      return toolError("x402_prepare_payment", {
        code: "PROVIDER_ERROR",
        message: "Could not reach that resource. This may be temporary.",
        retryable: true,
      });
    }

    if (response.status !== 402) {
      return toolError("x402_prepare_payment", {
        code: "DATA_UNAVAILABLE",
        message: "This resource is not currently requesting payment — there is nothing to prepare.",
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return toolError("x402_prepare_payment", {
        code: "DATA_UNAVAILABLE",
        message: "This resource returned 402 but its response body was not valid JSON.",
      });
    }

    const parsed = parseX402PaymentRequired(body);
    if (!parsed.ok) {
      return toolError("x402_prepare_payment", {
        code: "DATA_UNAVAILABLE",
        message: parsed.error.message,
      });
    }

    const index = typeof optionIndex === "number" ? optionIndex : 0;
    const chosen = parsed.requirements[index];
    if (!chosen) {
      return toolError("x402_prepare_payment", {
        code: "INVALID_INPUT",
        message: `optionIndex ${index} is out of range — this resource offered ${parsed.requirements.length} option(s).`,
      });
    }

    const proposalResult = buildX402PaymentProposal(resourceUrl, chosen);
    if (!proposalResult.ok) {
      return toolError("x402_prepare_payment", {
        code: "DATA_UNAVAILABLE",
        message: proposalResult.error.message,
      });
    }

    return toolSuccess("x402_prepare_payment", { proposal: proposalResult.proposal });
  },
};

// --- Registration --------------------------------------------------------

const registry = getAgentToolRegistry();
for (const tool of [x402DiscoverResourceTool, x402PreparePaymentTool]) {
  if (!registry.has(tool.id)) {
    registry.register(tool);
  }
}
