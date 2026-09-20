// Minimal typings for fengari (pure-JS Lua 5.3), test-only. The package
// ships no types; only the surface used by lua-redis.ts is declared.
declare module "fengari" {
  export const lua: Record<string, any>;
  export const lauxlib: Record<string, any>;
  export const lualib: Record<string, any>;
  export function to_luastring(value: string): Uint8Array;
  export function to_jsstring(value: Uint8Array): string;
}
