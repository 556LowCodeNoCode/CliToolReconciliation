/**
 * Windows-1253 (Greek) decoder.
 *
 * Single-byte codepage: 0x00–0x7F is ASCII; the high half is mapped through the
 * table below, generated from the canonical Unicode mapping (python cp1253 codec).
 * -1 marks codepoints that are undefined in Windows-1253; encountering one in the
 * input is treated as a decoding failure (the source file is then not CP1253).
 */
const HIGH_TABLE: readonly number[] = [
  0x20ac, -1, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, -1, 0x2030, -1,
  0x2039, -1, -1, -1, -1, -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013,
  0x2014, -1, 0x2122, -1, 0x203a, -1, -1, -1, -1, 0xa0, 0x385, 0x386, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, -1, 0xab, 0xac, 0xad, 0xae, 0x2015,
  0xb0, 0xb1, 0xb2, 0xb3, 0x384, 0xb5, 0xb6, 0xb7, 0x388, 0x389, 0x38a, 0xbb,
  0x38c, 0xbd, 0x38e, 0x38f, 0x390, 0x391, 0x392, 0x393, 0x394, 0x395, 0x396,
  0x397, 0x398, 0x399, 0x39a, 0x39b, 0x39c, 0x39d, 0x39e, 0x39f, 0x3a0, 0x3a1,
  -1, 0x3a3, 0x3a4, 0x3a5, 0x3a6, 0x3a7, 0x3a8, 0x3a9, 0x3aa, 0x3ab, 0x3ac,
  0x3ad, 0x3ae, 0x3af, 0x3b0, 0x3b1, 0x3b2, 0x3b3, 0x3b4, 0x3b5, 0x3b6, 0x3b7,
  0x3b8, 0x3b9, 0x3ba, 0x3bb, 0x3bc, 0x3bd, 0x3be, 0x3bf, 0x3c0, 0x3c1, 0x3c2,
  0x3c3, 0x3c4, 0x3c5, 0x3c6, 0x3c7, 0x3c8, 0x3c9, 0x3ca, 0x3cb, 0x3cc, 0x3cd,
  0x3ce, -1,
];

export class Cp1253DecodeError extends Error {
  constructor(byte: number, offset: number) {
    super(
      `Byte 0x${byte.toString(16).padStart(2, "0")} at offset ${offset} is not defined in Windows-1253 — input is not valid CP1253 text`,
    );
    this.name = "Cp1253DecodeError";
  }
}

export function decodeCp1253(buf: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b < 0x80) {
      out.push(String.fromCharCode(b));
    } else {
      const cp = HIGH_TABLE[b - 0x80]!;
      if (cp === -1) throw new Cp1253DecodeError(b, i);
      out.push(String.fromCharCode(cp));
    }
  }
  return out.join("");
}

/** Inverse mapping, used for test-fixture generation. Throws on unmappable codepoints. */
export function encodeCp1253(text: string): Uint8Array {
  const inverse = new Map<number, number>();
  for (let i = 0; i < HIGH_TABLE.length; i++) {
    const cp = HIGH_TABLE[i]!;
    if (cp !== -1) inverse.set(cp, 0x80 + i);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp < 0x80) {
      out[i] = cp;
    } else {
      const b = inverse.get(cp);
      if (b === undefined) {
        throw new Error(`Codepoint U+${cp.toString(16)} cannot be encoded in Windows-1253`);
      }
      out[i] = b;
    }
  }
  return out;
}
