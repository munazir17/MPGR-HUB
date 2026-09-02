// lib/architecture/tools/x402-tool-definitions.ts
//
// P3 — x402 Agentic Commerce, agent-facing tools.
//
// Exactly two tools:
//
//   x402_discover_resource  (mode: "read")
//     Performs read-only x402 discovery through this app's own
//     same-origin /api/x402/discover route. The browser therefore never
//     directly fetches an arbitrary third-party resource and discovery
//     does not depend on the resource server's CORS policy.
//
//   x402_prepare_payment    (mode: "prepare")
//     Re-discovers the resource through the same server-side discovery
//     route and builds a structured X402PaymentProposal. It never signs,
//     never touches a wallet, and never submits a payment.
//
// IMPORTANT SAFETY BOUNDARY
// -------------------------
// These tools deliberately contain NO execute-mode x402 tool.
// The AI can discover and prepare a proposal, but signing/submission
// remains exclusively behind the explicit Confirm & Pay UI flow.

import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";
import { buildX402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";

const DISCOVERY_API_PATH = "/api/x402/discover";
const CANONICAL_APP_ORIGIN = "https://mpgrhub.xyz";

function originFromConfiguredHost(value: string | undefined): string | null {
  if (!value) return null;
  const host = value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!host) return null;
  return `https://${host}`;
}

/**
 * Same-deployment origin for /api/x402/discover.
 *
 * Tools run in the Next/Vercel server runtime as well as the browser.
 * Never use window.location and never accept an origin from the model
 * or request body. The resource URL stays a separate validated HTTPS
 * input; this function only chooses this app's own discover route.
 */
function resolveDiscoveryEndpoint(): string {
  const origin =
    originFromConfiguredHost(process.env.NEXT_PUBLIC_APP_URL) ||
    originFromConfiguredHost(process.env.NEXT_PUBLIC_SITE_URL) ||
    originFromConfiguredHost(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    originFromConfiguredHost(process.env.VERCEL_URL) ||
    CANONICAL_APP_ORIGIN;

  return `${origin}${DISCOVERY_API_PATH}`;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Same-origin discovery. The route always returns HTTP 200 with:
 *   { status, body, finalUrl }
 * `status` is the upstream x402 status (402 when payment is required).
 */
async function discoverResourceServerSide(resourceUrl: string): Promise<{
  status: number;
  body: unknown | null;
  finalUrl: string;
}> {
  const response = await fetch(resolveDiscoveryEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ resourceUrl }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        status?: unknown;
        body?: unknown;
        finalUrl?: unknown;
        error?: unknown;
      }
    | null;

  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : "Could not reach that resource. This may be temporary.",
    );
  }

  return {
    status: typeof payload?.status === "number" ? payload.status : 0,
    body: payload?.body ?? null,
    finalUrl:
      typeof payload?.finalUrl === "string" ? payload.finalUrl : resourceUrl,
  };
}

const discoverSchema: AgentToolSchema = {
  type: "object",
  properties: {
    resourceUrl: {
      type: "string",
      description:
        "The full https:// URL of the resource to check for an x402 payment requirement.",
    },
  },
  required: ["resourceUrl"],
};

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

    try {
      const discovered = await discoverResourceServerSide(resourceUrl);

      // Envelope status — not the HTTP status of /api/x402/discover.
      if (discovered.status !== 402) {
        return toolSuccess("x402_discover_resource", {
          resourceUrl,
          finalUrl: discovered.finalUrl,
          paymentRequired: false,
          status: discovered.status,
        });
      }

      const parsed = parseX402PaymentRequired(discovered.body);
      if (!parsed.ok) {
        return toolError("x402_discover_resource", {
          code: "DATA_UNAVAILABLE",
          message: parsed.error.message,
        });
      }

      return toolSuccess("x402_discover_resource", {
        resourceUrl,
        finalUrl: discovered.finalUrl,
        paymentRequired: true,
        x402Version: parsed.x402Version,
        options: parsed.requirements.map((parsedRequirement, index) => {
          const requirement = parsedRequirement.requirement;
          return {
            index,
            scheme: requirement.scheme,
            network: requirement.network,
            asset: requirement.asset,
            maxAmountRequired: requirement.maxAmountRequired,
            payTo: requirement.payTo,
            description: requirement.description,
            mimeType: requirement.mimeType,
            maxTimeoutSeconds: requirement.maxTimeoutSeconds,
          };
        }),
      });
    } catch {
      return toolError("x402_discover_resource", {
        code: "PROVIDER_ERROR",
        message: "Could not reach that resource. This may be temporary.",
        retryable: true,
      });
    }
  },
};

const preparePaymentSchema: AgentToolSchema = {
  type: "object",
  properties: {
    resourceUrl: {
      type: "string",
      description:
        "The same https:// URL previously discovered with x402_discover_resource.",
    },
    optionIndex: {
      type: "number",
      description:
        "Which x402_discover_resource returned option to prepare a payment for. Defaults to 0 when omitted.",
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
    const { resourceUrl, optionIndex } = (input ?? {}) as {
      resourceUrl?: unknown;
      optionIndex?: unknown;
    };

    if (!isHttpsUrl(resourceUrl)) {
      return toolError("x402_prepare_payment", {
        code: "INVALID_INPUT",
        message: "resourceUrl must be a valid https:// URL.",
      });
    }

    if (
      optionIndex !== undefined &&
      (typeof optionIndex !== "number" ||
        !Number.isInteger(optionIndex) ||
        optionIndex < 0)
    ) {
      return toolError("x402_prepare_payment", {
        code: "INVALID_INPUT",
        message: "optionIndex, if provided, must be a non-negative integer.",
      });
    }

    try {
      const discovered = await discoverResourceServerSide(resourceUrl);

      if (discovered.status !== 402) {
        return toolError("x402_prepare_payment", {
          code: "DATA_UNAVAILABLE",
          message:
            "This resource is not currently requesting payment — there is nothing to prepare.",
        });
      }

      const parsed = parseX402PaymentRequired(discovered.body);
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

      const proposalResult = buildX402PaymentProposal(
        chosen.requirement.resource,
        chosen,
      );
      if (!proposalResult.ok) {
        return toolError("x402_prepare_payment", {
          code: "DATA_UNAVAILABLE",
          message: proposalResult.error.message,
        });
      }

      const proposal: X402PaymentProposal = proposalResult.proposal;
      return toolSuccess("x402_prepare_payment", { proposal });
    } catch {
      return toolError("x402_prepare_payment", {
        code: "PROVIDER_ERROR",
        message: "Could not reach that resource. This may be temporary.",
        retryable: true,
      });
    }
  },
};

const registry = getAgentToolRegistry();
for (const tool of [x402DiscoverResourceTool, x402PreparePaymentTool]) {
  if (!registry.has(tool.id)) {
    registry.register(tool);
  }
}
