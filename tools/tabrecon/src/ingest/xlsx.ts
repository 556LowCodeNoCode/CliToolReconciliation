/**
 * Minimal xlsx (OOXML spreadsheet) reader — first worksheet only, all cells
 * returned as strings exactly as stored (numbers keep their raw lexical form,
 * shared strings resolved). Adapted from the proven fpsl-edw-recon reader.
 * Not a general spreadsheet engine: no formulas, no styles, no date conversion.
 */
import { unzipSync } from "fflate";

export class XlsxReadError extends Error {
  constructor(file: string, why: string) {
    super(`Cannot read xlsx "${file}": ${why}`);
    this.name = "XlsxReadError";
  }
}

const td = new TextDecoder("utf-8");

function xmlUnescape(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replaceAll(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replaceAll("&amp;", "&");
}

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sharedStringText(si: string): string {
  const texts = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlUnescape(m[1]!));
  return texts.join("");
}

/** Parse an xlsx buffer into a dense string matrix (trimmed; missing cells ""). */
export function readFirstSheet(fileName: string, content: Uint8Array): string[][] {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(content);
  } catch (e) {
    throw new XlsxReadError(fileName, `not a readable zip archive (${String(e)})`);
  }

  const strings: string[] = [];
  const sstXml = zip["xl/sharedStrings.xml"];
  if (sstXml) {
    for (const m of td.decode(sstXml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      strings.push(sharedStringText(m[1]!));
    }
  }

  const sheetXml = zip["xl/worksheets/sheet1.xml"];
  if (!sheetXml) throw new XlsxReadError(fileName, "missing xl/worksheets/sheet1.xml");
  const sheetText = td.decode(sheetXml);

  const rows: string[][] = [];
  let maxCols = 0;
  for (const rowMatch of sheetText.matchAll(/<row\s[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIdx = Number.parseInt(rowMatch[1]!, 10) - 1;
    const cells: string[] = [];
    for (const c of rowMatch[2]!.matchAll(
      /<c\s+r="([A-Z]+)\d+"((?:\s[^>]*)?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const colIdx = colLetterToIndex(c[1]!);
      const attrs = c[2] ?? "";
      const body = c[3] ?? "";
      const typeMatch = /t="(\w+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1]! : "n";
      let value = "";
      if (type === "inlineStr") {
        value = sharedStringText(body);
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        if (v) {
          const rawV = xmlUnescape(v[1]!);
          if (type === "s") {
            const si = strings[Number.parseInt(rawV, 10)];
            if (si === undefined) {
              throw new XlsxReadError(fileName, `shared-string index ${rawV} out of range`);
            }
            value = si;
          } else {
            value = rawV;
          }
        }
      }
      cells[colIdx] = value.trim();
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    rows[rowIdx] = cells;
    if (cells.length > maxCols) maxCols = cells.length;
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === undefined) rows[i] = [];
    while (rows[i]!.length < maxCols) rows[i]!.push("");
  }
  return rows;
}
