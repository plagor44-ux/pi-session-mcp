import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Length of the per-run key the supervisor hands to `run-one` on stdin (R35). */
export const RUN_KEY_BYTES = 32;

export const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** JSON with every object's keys sorted, so the MAC does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** HMAC-SHA256 over the canonical JSON of the output without its `mac` field. */
export function macOf(output: Record<string, unknown>, key: Uint8Array): string {
  const { mac: _mac, ...rest } = output;
  return createHmac("sha256", key).update(canonicalJson(rest)).digest("hex");
}

export function macMatches(output: Record<string, unknown>, key: Uint8Array): boolean {
  const claimed = output.mac;
  if (typeof claimed !== "string" || !/^[0-9a-f]{64}$/.test(claimed)) return false;
  return timingSafeEqual(Buffer.from(claimed, "hex"), Buffer.from(macOf(output, key), "hex"));
}

/** The key as written to the child's stdin: lower-case hex and a newline. */
export const encodeKey = (key: Uint8Array): string => `${Buffer.from(key).toString("hex")}\n`;

export function decodeKey(text: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw Object.assign(new Error("run_key_invalid"), { code: "run_key_invalid" });
  return Buffer.from(hex, "hex");
}
