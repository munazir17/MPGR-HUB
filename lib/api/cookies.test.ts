import { describe, expect, it } from "vitest";
import { readCookieValue } from "./cookies";

describe("readCookieValue", () => {
  it("reads a simple cookie", () => {
    expect(readCookieValue("mpgr_session=abc.def; other=1", "mpgr_session")).toBe("abc.def");
  });

  it("decodes a URI-encoded value", () => {
    expect(readCookieValue("mpgr_auth_nonce=hello%2Fworld", "mpgr_auth_nonce")).toBe("hello/world");
  });

  it("returns undefined when the cookie is missing", () => {
    expect(readCookieValue("a=1; b=2", "mpgr_session")).toBeUndefined();
    expect(readCookieValue("", "mpgr_session")).toBeUndefined();
  });

  it("does not match a prefix of another cookie name", () => {
    expect(readCookieValue("mpgr_session_backup=nope; mpgr_session=yes", "mpgr_session")).toBe("yes");
  });
});
