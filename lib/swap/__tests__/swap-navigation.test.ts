import { it, expect } from "vitest";
import { hasUsefulSwapHistory as useful } from "../swap-navigation";
const here="https://mpgrhub.xyz/swap";
it("allows a proven same-origin previous in-app route",()=>expect(useful(here,"https://mpgrhub.xyz/agent","",2)).toBe(true));
it.each([null,"https://evil.example/agent","https://mpgrhub.xyz/swap#token","javascript:alert(1)","blob:https://mpgrhub.xyz/id","https://mpgrhub.xyz/api/auth","https://mpgrhub.xyz/swap/","bad-url"])("direct, external, hash-only and malformed history falls back: %s",p=>expect(useful(here,p,"https://mpgrhub.xyz/agent",2)).toBe(false));
it("does not use a stale referrer when the Navigation API knows there is no prior entry",()=>expect(useful(here,null,"https://mpgrhub.xyz/agent",3)).toBe(false));
it("older browsers can use same-origin referrer but never an external one or empty history",()=>{
 expect(useful(here,undefined,"https://mpgrhub.xyz/profile",2)).toBe(true);expect(useful(here,undefined,"https://evil.example/profile",2)).toBe(false);expect(useful(here,undefined,"https://mpgrhub.xyz/profile",1)).toBe(false);
});
