import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { swapTokenLogo } from "../token-logos";
import manifest from "../token-logos.json";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { BASE_WETH, NATIVE_ETH_SENTINEL, TRADE_CHAIN_ID } from "@/lib/trade/trade-config";
const token=(symbol:string)=>MANUAL_SWAP_TOKENS.find(t=>t.symbol===symbol)!;
it("pins Base Mainnet, native sentinel identity and the exact Base WETH ERC20",()=>{
 expect(TRADE_CHAIN_ID).toBe(8453);expect(BASE_WETH).toBe("0x4200000000000000000000000000000000000006");expect(token("ETH")).toMatchObject({address:NATIVE_ETH_SENTINEL,kind:"native"});expect(token("WETH")).toMatchObject({address:BASE_WETH,kind:"erc20"});
});
it.each(["ETH","WETH","USDC","cbETH"])("official cached artwork is contract/chain-bound: %s",symbol=>{
 const t=token(symbol);expect(swapTokenLogo(t)).toMatch(/^\/tokens\/base\/0x[0-9a-f]{40}\.png$/);expect(swapTokenLogo({...t,address:t.address.toLowerCase() as typeof t.address})).toBe(swapTokenLogo(t));expect(swapTokenLogo(t,1)).toBeNull();expect(swapTokenLogo({...t,verified:false})).toBe(swapTokenLogo(t)); // manifest address match, not the verified flag, anchors artworkexpect(swapTokenLogo({...t,kind:t.kind==="native"?"erc20":"native"})).toBeNull();
});
it("a symbol, arbitrary remote URL or forged verified flag never supplies artwork for another contract",()=>{
 const fake={...token("USDC"),address:"0x1234567890abcdef1234567890abcdef12345678" as const,logoURI:"https://evil.example/logo.svg"};expect(swapTokenLogo(fake)).toBeNull();expect(swapTokenLogo({...token("USDC"),symbol:"FAKE"})).toBe(swapTokenLogo(token("USDC")));expect(swapTokenLogo(token("AAPLc"))).toBeNull();
 const usdc = token("USDC"); expect(swapTokenLogo({...usdc,verified:false,address:"0xa1000000000000000000000000000000000000aa" as typeof usdc.address})).toBeNull();
});
it("every vendored file matches its pinned content hash and is a bounded raster, not executable SVG",()=>{
 for(const entry of Object.values(manifest.tokens)){const data=readFileSync(`public${entry.src}`);expect(data.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");expect(data.length).toBeLessThan(262144);expect(createHash("sha256").update(data).digest("hex")).toBe(entry.sha256);expect(entry.source).toMatch(/github.com\/trustwallet\/assets\/blob\/[0-9a-f]{40}\//);}
});
