// No invisible controls, bidi overrides or zero-width identities. React still escapes markup.
export function safeSwapTokenText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}
