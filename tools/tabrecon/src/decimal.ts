/**
 * Exact decimal arithmetic on scaled micro-units (value × 10^6) as BigInt.
 * No binary floating point ever touches an amount.
 *
 * Two lexical number formats are supported:
 *   standard  1,234,567.89   -1.5   (1.5)        ("." decimal, "," thousands)
 *   greek     1.234.567,89   1,50-  ("," decimal, "." thousands, trailing minus)
 */
import { NumberFormatError } from "./errors.ts";

export const SCALE = 6;
export const MICRO = 10n ** 6n;

export type NumberFormat = "standard" | "greek";

/**
 * Parse one lexical value into micro-units. Throws NumberFormatError on
 * anything inexact. With `allowRounding` (xlsx sources only — binary-float
 * lexical artifacts like "…40000001"), digits beyond the 6th decimal are
 * rounded half-away-from-zero instead of rejected.
 */
export function parseDecimalToMicros(
  raw: string,
  format: NumberFormat,
  allowRounding = false,
): bigint {
  const s = raw.trim();
  if (s === "") throw new NumberFormatError(`Empty string is not a number`);
  let body = s;
  let negative = false;

  if (format === "standard") {
    if (body.startsWith("(") && body.endsWith(")")) {
      negative = true;
      body = body.slice(1, -1);
    }
    if (body.startsWith("-")) {
      if (negative) throw new NumberFormatError(`"${raw}" combines two negative markers`);
      negative = true;
      body = body.slice(1);
    }
    // xlsx numeric cells sometimes carry scientific notation ("7.00…E-2");
    // accepted only on the rounding (xlsx) path, expanded exactly.
    if (allowRounding && /^[0-9]+(?:\.[0-9]+)?[eE][+-]?[0-9]+$/.test(body)) {
      body = expandScientific(body);
    }
    if (!/^[0-9][0-9,]*(?:\.[0-9]+)?$/.test(body)) {
      throw new NumberFormatError(`"${raw}" is not a valid standard-format number`);
    }
    body = body.replaceAll(",", "");
    return signed(splitParts(raw, body, ".", allowRounding), negative);
  }

  // greek
  if (body.endsWith("-")) {
    negative = true;
    body = body.slice(0, -1);
  }
  if (body.startsWith("-")) {
    if (negative) throw new NumberFormatError(`"${raw}" combines two negative markers`);
    negative = true;
    body = body.slice(1);
  }
  if (!/^[0-9][0-9.]*(?:,[0-9]+)?$/.test(body)) {
    throw new NumberFormatError(`"${raw}" is not a valid greek-format number`);
  }
  body = body.replaceAll(".", "");
  return signed(splitParts(raw, body, ",", allowRounding), negative);
}

function splitParts(raw: string, body: string, decimalSep: string, allowRounding = false): bigint {
  const idx = body.indexOf(decimalSep);
  const intPart = idx === -1 ? body : body.slice(0, idx);
  let fracPart = idx === -1 ? "" : body.slice(idx + 1);
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) {
    throw new NumberFormatError(`"${raw}" contains unexpected characters`);
  }
  let carry = 0n;
  if (fracPart.length > SCALE) {
    if (!allowRounding) {
      throw new NumberFormatError(
        `"${raw}" has ${fracPart.length} decimal places — more than the supported ${SCALE}`,
      );
    }
    if (fracPart.charCodeAt(SCALE) >= 0x35 /* '5' */) carry = 1n;
    fracPart = fracPart.slice(0, SCALE);
  }
  const frac = fracPart.padEnd(SCALE, "0");
  return BigInt(intPart === "" ? "0" : intPart) * MICRO + BigInt(frac === "" ? "0" : frac) + carry;
}

function signed(magnitude: bigint, negative: boolean): bigint {
  return negative ? -magnitude : magnitude;
}

/** Expand an unsigned scientific-notation body ("7.05E-2") to a plain decimal string, exactly. */
function expandScientific(body: string): string {
  const m = /^([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$/.exec(body)!;
  const intPart = m[1]!;
  const fracPart = m[2] ?? "";
  const exp = Number.parseInt(m[3]!, 10);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) return `0.${"0".repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return digits + "0".repeat(pointPos - digits.length);
  return `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/** Canonical plain decimal string ("1234.56", "-0.000001", "42"). */
export function formatMicros(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const intPart = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${intPart}${frac === "" ? "" : `.${frac}`}`;
}

export function absMicros(m: bigint): bigint {
  return m < 0n ? -m : m;
}

/** Round-half-away-from-zero division of two bigints. */
function divRoundHalfAway(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new NumberFormatError("Division by zero in exact-decimal arithmetic");
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** a × factor, both micro-scaled; result micro-scaled, half-away rounding. */
export function mulMicros(a: bigint, factorMicros: bigint): bigint {
  return divRoundHalfAway(a * factorMicros, MICRO);
}

/** a ÷ divisor, both micro-scaled; result micro-scaled, half-away rounding. */
export function divMicros(a: bigint, divisorMicros: bigint): bigint {
  return divRoundHalfAway(a * MICRO, divisorMicros);
}

const GREEK_EVIDENCE = /(,\d{1,6}-?$)|(-?\d{1,3}(\.\d{3}){2,},?)|(\d-$)/;
const STANDARD_EVIDENCE = /(\.\d{1,6}\)?$)|(-?\(?\d{1,3}(,\d{3}){1,})|(^\()/;

/**
 * Decide the lexical number format of a column from its non-null samples.
 * `encodingHint` biases ambiguous columns (cp1253 → greek), documented behavior.
 * Mixed evidence raises NumberFormatError; no evidence → null (plain integers).
 */
export function detectNumberFormat(
  samples: readonly string[],
  encodingHint: "greek" | "standard",
): NumberFormat | null {
  let greek = 0;
  let standard = 0;
  for (const s of samples) {
    const t = s.trim();
    if (GREEK_EVIDENCE.test(t)) greek++;
    if (STANDARD_EVIDENCE.test(t)) standard++;
  }
  if (greek > 0 && standard > 0) {
    throw new NumberFormatError(
      `Column mixes greek-format and standard-format number evidence (${greek} vs ${standard} samples) — provide a parse spec`,
    );
  }
  if (greek > 0) return "greek";
  if (standard > 0) return "standard";
  // No separator evidence at all (e.g. "1234", "-5"): both formats parse identically.
  const anyDecimalish = samples.some((s) => /[.,]/.test(s));
  if (!anyDecimalish) return null;
  return encodingHint;
}

/** True when every sample parses under the given format. */
export function allParse(samples: readonly string[], format: NumberFormat): boolean {
  for (const s of samples) {
    try {
      parseDecimalToMicros(s, format);
    } catch {
      return false;
    }
  }
  return true;
}
