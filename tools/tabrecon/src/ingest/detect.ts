/**
 * Encoding, delimiter, and header detection for text sources.
 * Probe order (repo-A pattern, deterministic, never guesses):
 *   1. UTF-8 BOM  →  utf-8-bom
 *   2. strict UTF-8 decode  →  utf-8
 *   3. CP1253 decode + Greek-coherence check (≥ GREEK_MIN Greek letters)  →  cp1253
 *   4. anything else  →  EncodingAmbiguityError
 */
import {
  DelimiterAmbiguityError,
  EncodingAmbiguityError,
  HeaderDetectionError,
} from "../errors.ts";
import { decodeCp1253 } from "./cp1253.ts";

export type Encoding = "utf-8" | "utf-8-bom" | "cp1253";

const GREEK_MIN = 7;

export function detectEncodingAndDecode(
  fileName: string,
  buf: Uint8Array,
): { encoding: Encoding; text: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(3));
    return { encoding: "utf-8-bom", text };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { encoding: "utf-8", text };
  } catch {
    /* not UTF-8 — try CP1253 */
  }
  let cp1253Text: string | null = null;
  try {
    cp1253Text = decodeCp1253(buf);
  } catch {
    cp1253Text = null;
  }
  if (cp1253Text !== null) {
    let greek = 0;
    for (const ch of cp1253Text) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x0386 && cp <= 0x03ce) greek++;
      if (greek >= GREEK_MIN) break;
    }
    if (greek >= GREEK_MIN) return { encoding: "cp1253", text: cp1253Text };
    throw new EncodingAmbiguityError(
      fileName,
      `not valid UTF-8; decodes as Windows-1253 but contains fewer than ${GREEK_MIN} Greek letters, so CP1253 cannot be asserted`,
    );
  }
  throw new EncodingAmbiguityError(fileName, "not valid UTF-8 and not valid Windows-1253");
}

const DELIMITER_CANDIDATES = [",", ";", "\t", "|"] as const;

/** Count delimiter occurrences outside double-quoted regions. */
function countOutsideQuotes(line: string, delim: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delim && !inQuotes) count++;
  }
  return count;
}

export function sniffDelimiter(fileName: string, text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 50);
  if (lines.length === 0) {
    throw new DelimiterAmbiguityError(fileName, "the file contains no non-empty lines");
  }
  interface Score {
    delim: string;
    count: number;
    consistency: number;
  }
  const scores: Score[] = [];
  for (const delim of DELIMITER_CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, delim));
    const first = counts[0]!;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    if (consistent >= 0.9) scores.push({ delim, count: first, consistency: consistent });
  }
  if (scores.length === 0) {
    throw new DelimiterAmbiguityError(
      fileName,
      `none of ${DELIMITER_CANDIDATES.map((d) => JSON.stringify(d)).join(", ")} appears consistently across lines`,
    );
  }
  scores.sort((a, b) => b.consistency - a.consistency || b.count - a.count);
  const [best, second] = scores;
  if (second && second.consistency === best!.consistency && second.count === best!.count) {
    throw new DelimiterAmbiguityError(
      fileName,
      `both ${JSON.stringify(best!.delim)} and ${JSON.stringify(second.delim)} fit equally well`,
    );
  }
  return best!.delim;
}

const NUMBERISH = /^[0-9.,()\-\s]+$/;

/**
 * The first row must qualify as a header: ≥ 2 cells, no cell empty, no cell
 * purely numeric, and all cells distinct after normalization. Anything else
 * raises HeaderDetectionError (provide a parse spec instead).
 */
export function assertHeaderRow(fileName: string, cells: readonly string[]): void {
  if (cells.length < 2) {
    throw new HeaderDetectionError(fileName, `first row has ${cells.length} cell(s), need at least 2`);
  }
  const seen = new Set<string>();
  for (const c of cells) {
    const t = c.trim();
    if (t === "") throw new HeaderDetectionError(fileName, "first row contains an empty cell");
    if (NUMBERISH.test(t)) {
      throw new HeaderDetectionError(fileName, `first-row cell "${t}" looks numeric, not a column name`);
    }
    const norm = t.normalize("NFKC").toLowerCase();
    if (seen.has(norm)) {
      throw new HeaderDetectionError(fileName, `duplicate column name "${t}"`);
    }
    seen.add(norm);
  }
}
