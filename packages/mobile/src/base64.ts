/**
 * Dependency-free base64. `Buffer` is Node-only and neither `atob` nor `btoa` is guaranteed on
 * every React Native runtime, so the HTTP body codec cannot rely on either.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(256).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) LOOKUP[ALPHABET.charCodeAt(index)] = index;

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]!;
    out += b === undefined ? "=" : ALPHABET[(triple >> 6) & 63]!;
    out += c === undefined ? "=" : ALPHABET[triple & 63]!;
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[\r\n\s]/gu, "");
  if (clean.length === 0) return new Uint8Array(0);
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4) - padding);
  let accumulator = 0;
  let bits = 0;
  let cursor = 0;
  for (const character of clean) {
    if (character === "=") break;
    const value6 = LOOKUP[character.charCodeAt(0)] ?? -1;
    if (value6 < 0) throw new Error("Invalid base64 input");
    accumulator = (accumulator << 6) | value6;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[cursor] = (accumulator >> bits) & 255;
      cursor += 1;
    }
  }
  return bytes;
}
