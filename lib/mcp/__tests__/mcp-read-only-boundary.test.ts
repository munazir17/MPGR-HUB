import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ChainReader } from "@/lib/executor/executor-chain";

// Syntax-aware guard: comments and the wallet instructions returned to clients
// are NOT server-side calls. HMAC quote-id signing is deliberately permitted;
// wallet/private-key signing and broadcasting are not.
const forbiddenIdentifiers = new Set([
  "createWalletClient", "createTestClient", "privateKeyToAccount", "mnemonicToAccount", "hdKeyToAccount",
  "signTransaction", "signMessage", "signTypedData", "sendTransaction", "sendRawTransaction",
  "writeContract", "broadcastTransaction", "sendUserOperation", "signUserOperation",
]);
const forbiddenRpc = new Set([
  "eth_sendTransaction", "eth_sendRawTransaction", "eth_sendUserOperation",
  "eth_sign", "eth_signTransaction", "personal_sign", "personal_sendTransaction",
  "wallet_sendCalls", "wallet_sendTransaction",
]);

function violations(source: string): string[] {
  const file = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) found.push(node.text);
    if (ts.isStringLiteralLike(node)) {
      // Permit the plain-text signTypedData step / eth_signTypedData_v4 method:
      // these tell the USER'S wallet what to do; they do not invoke a signer.
      if (forbiddenRpc.has(node.text) || /^(viem\/accounts|ethers(?:\/.*)?)$/.test(node.text)) found.push(node.text);
      if (ts.isElementAccessExpression(node.parent) && forbiddenIdentifiers.has(node.text)) found.push(node.text);
      if (/PRIVATE_KEY|MNEMONIC|WALLET_SEED/.test(node.text)) found.push(node.text);
    }
    if (ts.isPropertyAccessExpression(node) && /PRIVATE_KEY|MNEMONIC|WALLET_SEED/.test(node.name.text)) found.push(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

const productionFiles = [
  ...["lib/mcp", "lib/executor"].flatMap((directory) => readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(directory, name))),
  "app/api/mcp/route.ts",
];

describe("MCP / executor non-custodial source boundary", () => {
  it("exposes only chain reads and eth_call simulation through ChainReader", () => {
    expectTypeOf<keyof ChainReader>().toEqualTypeOf<
      "chainId" | "readContract" | "simulateContract" | "getBalance" | "getTransactionReceipt"
    >();
  });

  it.each(productionFiles)("%s has no private-key account creation, wallet signing or broadcasting", (file) => {
    expect(violations(readFileSync(file, "utf8"))).toEqual([]);
  });

  it.each([
    'import { privateKeyToAccount as account } from "viem/accounts";',
    'const wallet = createWalletClient({ account });',
    'await wallet.signTransaction(tx);',
    'await wallet["sendRawTransaction"]({ serializedTransaction });',
    'await fetch(url, { body: JSON.stringify({ method: "eth_sendRawTransaction" }) });',
    'const key = process.env.PRIVATE_KEY;',
    'const key = process.env["WALLET_SEED"];',
  ])("the guard rejects a write/signing regression: %s", (source) => {
    expect(violations(source).length).toBeGreaterThan(0);
  });

  it("allows read simulation, HMAC quote IDs, and explicit user-wallet instructions", () => {
    expect(violations(`
      const quoteId = signQuoteId(payload, secret);
      await reader.simulateContract(args);
      steps.push({ step: "signTypedData", who: "user wallet", method: "eth_signTypedData_v4" });
      steps.push({ step: "sendSwapTransaction", who: "user wallet", transactionRequest });
    `)).toEqual([]);
  });
});
