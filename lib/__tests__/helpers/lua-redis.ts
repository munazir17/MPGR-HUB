// In-memory Redis double for tests that need to EXECUTE the repo's Lua
// scripts (xp-ledger, referral-store, auth nonce, session store) rather
// than string-match them. Runs Lua through fengari (pure-JS Lua 5.3) with a
// `redis.call` shim over a small command set. Not a full Redis: only the
// commands the app's scripts and stores use are implemented, and semantics
// are deliberately strict (throws on unknown commands) so a script that
// starts depending on something new fails loudly here instead of silently
// passing.
//
// Expiry is simulated with a controllable clock (`advance(ms)`), and keys
// with a TTL are lazily dropped when read after expiry — same observable
// behaviour as Redis.

import * as fengari from "fengari";

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

type Value =
  | { kind: "string"; value: string }
  | { kind: "set"; value: Set<string> }
  | { kind: "zset"; value: Map<string, number> };

interface Entry {
  value: Value;
  expiresAt: number | null;
}

type RedisReply = string | number | null | RedisReply[];

export class LuaRedis {
  private store = new Map<string, Entry>();
  private now = 1_700_000_000_000;
  /** Every command executed, in order (including those inside Lua). */
  public readonly log: string[][] = [];

  advance(ms: number): void {
    this.now += ms;
  }

  /** Drop every key and the command log; the clock is left as-is. */
  reset(): void {
    this.store.clear();
    this.log.length = 0;
  }

  /** Snapshot of live keys (expired ones excluded). */
  keys(): string[] {
    return [...this.store.keys()].filter((key) => this.live(key) !== undefined);
  }

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private str(key: string): string | null {
    const entry = this.live(key);
    if (!entry) return null;
    if (entry.value.kind !== "string") throw new Error("WRONGTYPE " + key);
    return entry.value.value;
  }

  private setStr(key: string, value: string, expiresAt: number | null): void {
    this.store.set(key, { value: { kind: "string", value }, expiresAt });
  }

  // ---- command dispatcher (used by both the JS client and Lua) ----------

  call(args: string[]): RedisReply {
    this.log.push([...args]);
    const [cmd, ...rest] = args;
    const name = cmd.toUpperCase();
    switch (name) {
      case "GET":
        return this.str(rest[0]);
      case "SET": {
        const [key, value, ...opts] = rest;
        let nx = false;
        let ex: number | null = null;
        for (let i = 0; i < opts.length; i += 1) {
          const opt = opts[i].toUpperCase();
          if (opt === "NX") nx = true;
          else if (opt === "EX") {
            ex = Number(opts[i + 1]);
            i += 1;
          } else throw new Error("unsupported SET option " + opt);
        }
        if (nx && this.live(key)) return null;
        this.setStr(key, value, ex === null ? null : this.now + ex * 1000);
        return "OK";
      }
      case "DEL": {
        let n = 0;
        for (const key of rest) if (this.live(key)) { this.store.delete(key); n += 1; }
        return n;
      }
      case "EXISTS": {
        let n = 0;
        for (const key of rest) if (this.live(key)) n += 1;
        return n;
      }
      case "INCR":
      case "DECR":
      case "INCRBY": {
        const key = rest[0];
        const delta = name === "INCR" ? 1 : name === "DECR" ? -1 : Number(rest[1]);
        if (!Number.isInteger(delta)) throw new Error("ERR value is not an integer or out of range");
        const entry = this.live(key);
        const current = entry ? Number(this.str(key)) : 0;
        if (!Number.isInteger(current)) throw new Error("ERR value is not an integer or out of range");
        const next = current + delta;
        this.setStr(key, String(next), entry?.expiresAt ?? null);
        return next;
      }
      case "EXPIRE": {
        const entry = this.live(rest[0]);
        if (!entry) return 0;
        entry.expiresAt = this.now + Number(rest[1]) * 1000;
        return 1;
      }
      case "PERSIST": {
        const entry = this.live(rest[0]);
        if (!entry || entry.expiresAt === null) return 0;
        entry.expiresAt = null;
        return 1;
      }
      case "TTL": {
        const entry = this.live(rest[0]);
        if (!entry) return -2;
        if (entry.expiresAt === null) return -1;
        return Math.ceil((entry.expiresAt - this.now) / 1000);
      }
      case "SADD": {
        const [key, ...members] = rest;
        let entry = this.live(key);
        if (!entry) {
          entry = { value: { kind: "set", value: new Set() }, expiresAt: null };
          this.store.set(key, entry);
        }
        if (entry.value.kind !== "set") throw new Error("WRONGTYPE " + key);
        let added = 0;
        for (const m of members) if (!entry.value.value.has(m)) { entry.value.value.add(m); added += 1; }
        return added;
      }
      case "SCARD": {
        const entry = this.live(rest[0]);
        if (!entry) return 0;
        if (entry.value.kind !== "set") throw new Error("WRONGTYPE " + rest[0]);
        return entry.value.value.size;
      }
      case "SISMEMBER": {
        const entry = this.live(rest[0]);
        if (!entry) return 0;
        if (entry.value.kind !== "set") throw new Error("WRONGTYPE " + rest[0]);
        return entry.value.value.has(rest[1]) ? 1 : 0;
      }
      case "ZINCRBY": {
        const [key, incr, member] = rest;
        let entry = this.live(key);
        if (!entry) {
          entry = { value: { kind: "zset", value: new Map() }, expiresAt: null };
          this.store.set(key, entry);
        }
        if (entry.value.kind !== "zset") throw new Error("WRONGTYPE " + key);
        const next = (entry.value.value.get(member) ?? 0) + Number(incr);
        entry.value.value.set(member, next);
        return String(next);
      }
      case "ZSCORE": {
        const entry = this.live(rest[0]);
        if (!entry) return null;
        if (entry.value.kind !== "zset") throw new Error("WRONGTYPE " + rest[0]);
        const score = entry.value.value.get(rest[1]);
        return score === undefined ? null : String(score);
      }
      case "ZREM": {
        const entry = this.live(rest[0]);
        if (!entry) return 0;
        if (entry.value.kind !== "zset") throw new Error("WRONGTYPE " + rest[0]);
        return entry.value.value.delete(rest[1]) ? 1 : 0;
      }
      case "ZCARD": {
        const entry = this.live(rest[0]);
        if (!entry) return 0;
        if (entry.value.kind !== "zset") throw new Error("WRONGTYPE " + rest[0]);
        return entry.value.value.size;
      }
      case "ZREVRANK": {
        const entry = this.live(rest[0]);
        if (!entry) return null;
        if (entry.value.kind !== "zset") throw new Error("WRONGTYPE " + rest[0]);
        const sorted = [...entry.value.value.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const idx = sorted.findIndex(([m]) => m === rest[1]);
        return idx === -1 ? null : idx;
      }
      default:
        throw new Error("LuaRedis: unsupported command " + name);
    }
  }

  // ---- Lua -----------------------------------------------------------------

  eval(script: string, keys: string[], args: Array<string | number>): RedisReply {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);

    // redis.call(...)
    lua.lua_newtable(L);
    lua.lua_pushjsfunction(L, (L2: unknown) => {
      const n = lua.lua_gettop(L2);
      const callArgs: string[] = [];
      for (let i = 1; i <= n; i += 1) callArgs.push(to_jsstring(lua.lua_tolstring(L2, i) ?? to_luastring("")));
      let reply: RedisReply;
      try {
        reply = this.call(callArgs);
      } catch (error) {
        lauxlib.luaL_error(L2, to_luastring(String(error instanceof Error ? error.message : error)));
        return 0;
      }
      pushReply(L2, reply);
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("call"));
    lua.lua_setglobal(L, to_luastring("redis"));

    pushStringArray(L, keys);
    lua.lua_setglobal(L, to_luastring("KEYS"));
    pushStringArray(L, args.map(String));
    lua.lua_setglobal(L, to_luastring("ARGV"));

    const status = lauxlib.luaL_dostring(L, to_luastring(script));
    if (status !== lua.LUA_OK) {
      throw new Error("Lua error: " + to_jsstring(lua.lua_tolstring(L, -1) ?? to_luastring("?")));
    }
    if (lua.lua_gettop(L) === 0) return null;
    return readReply(L, -1);
  }

  // ---- @upstash/redis-shaped client surface used by the app ----------------

  /** Minimal object satisfying the subset of the Upstash client the stores call. */
  client() {
    const self = this;
    return {
      async get<T = unknown>(key: string): Promise<T | null> {
        const raw = self.str(key);
        if (raw === null) return null;
        // Upstash auto-deserialises JSON values.
        try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
      },
      async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null> {
        const args = ["SET", key, typeof value === "string" ? value : JSON.stringify(value)];
        if (opts?.nx) args.push("NX");
        if (opts?.ex !== undefined) args.push("EX", String(opts.ex));
        return self.call(args) as "OK" | null;
      },
      async del(...keys: string[]): Promise<number> { return self.call(["DEL", ...keys]) as number; },
      async exists(...keys: string[]): Promise<number> { return self.call(["EXISTS", ...keys]) as number; },
      async incr(key: string): Promise<number> { return self.call(["INCR", key]) as number; },
      async expire(key: string, ttl: number): Promise<number> { return self.call(["EXPIRE", key, String(ttl)]) as number; },
      async ttl(key: string): Promise<number> { return self.call(["TTL", key]) as number; },
      async persist(key: string): Promise<number> { return self.call(["PERSIST", key]) as number; },
      async scard(key: string): Promise<number> { return self.call(["SCARD", key]) as number; },
      async sismember(key: string, member: string): Promise<number> { return self.call(["SISMEMBER", key, member]) as number; },
      async zscore(key: string, member: string): Promise<number | null> {
        const r = self.call(["ZSCORE", key, member]);
        return r === null ? null : Number(r);
      },
      async zrevrank(key: string, member: string): Promise<number | null> { return self.call(["ZREVRANK", key, member]) as number | null; },
      async zcard(key: string): Promise<number> { return self.call(["ZCARD", key]) as number; },
      async zrem(key: string, member: string): Promise<number> { return self.call(["ZREM", key, member]) as number; },
      async eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
        return self.eval(script, keys, args) as T;
      },
    };
  }
}

function pushStringArray(L: unknown, values: string[]): void {
  lua.lua_createtable(L, values.length, 0);
  values.forEach((value, index) => {
    lua.lua_pushstring(L, to_luastring(value));
    lua.lua_rawseti(L, -2, index + 1);
  });
}

function pushReply(L: unknown, reply: RedisReply): void {
  if (reply === null) {
    // Redis nil bulk reply -> Lua false
    lua.lua_pushboolean(L, false);
  } else if (typeof reply === "number") {
    lua.lua_pushinteger(L, reply);
  } else if (typeof reply === "string") {
    lua.lua_pushstring(L, to_luastring(reply));
  } else {
    lua.lua_createtable(L, reply.length, 0);
    reply.forEach((item, index) => {
      pushReply(L, item);
      lua.lua_rawseti(L, -2, index + 1);
    });
  }
}

function readReply(L: unknown, index: number): RedisReply {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL) return null;
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index) ? 1 : null;
  if (type === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, index));
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tolstring(L, index) ?? to_luastring(""));
  if (type === lua.LUA_TTABLE) {
    const out: RedisReply[] = [];
    const abs = lua.lua_absindex(L, index);
    for (let i = 1; ; i += 1) {
      lua.lua_rawgeti(L, abs, i);
      if (lua.lua_type(L, -1) === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
      out.push(readReply(L, -1));
      lua.lua_pop(L, 1);
    }
    return out;
  }
  return null;
}
