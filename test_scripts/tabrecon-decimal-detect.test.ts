import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MICRO,
  detectNumberFormat,
  divMicros,
  formatMicros,
  mulMicros,
  parseDecimalToMicros,
} from "../tools/tabrecon/src/decimal.ts";
import {
  assertHeaderRow,
  detectEncodingAndDecode,
  sniffDelimiter,
} from "../tools/tabrecon/src/ingest/detect.ts";
import { encodeCp1253 } from "../tools/tabrecon/src/ingest/cp1253.ts";
import { jaroWinkler, normKey } from "../tools/tabrecon/src/keys.ts";

test("decimal: standard format parses exactly", () => {
  assert.equal(parseDecimalToMicros("1,234,567.89", "standard"), 1234567890000n);
  assert.equal(parseDecimalToMicros("-1.5", "standard"), -1500000n);
  assert.equal(parseDecimalToMicros("(2.25)", "standard"), -2250000n);
  assert.equal(parseDecimalToMicros("0.000001", "standard"), 1n);
  assert.equal(parseDecimalToMicros("42", "standard"), 42n * MICRO);
});

test("decimal: greek format parses exactly (incl. trailing minus)", () => {
  assert.equal(parseDecimalToMicros("1.234.567,89", "greek"), 1234567890000n);
  assert.equal(parseDecimalToMicros("1,50-", "greek"), -1500000n);
  assert.equal(parseDecimalToMicros("13.094.739.310,85", "greek"), 13094739310850000n);
});

test("decimal: more than 6 decimal places is rejected, not rounded", () => {
  assert.throws(() => parseDecimalToMicros("1.1234567", "standard"), /decimal places/);
});

test("decimal: format round-trip is canonical", () => {
  assert.equal(formatMicros(parseDecimalToMicros("1234.560000", "standard")), "1234.56");
  assert.equal(formatMicros(-1n), "-0.000001");
  assert.equal(formatMicros(0n), "0");
});

test("decimal: mul/div round half away from zero", () => {
  // 1.0 × 0.5 = 0.5
  assert.equal(mulMicros(1000000n, 500000n), 500000n);
  // 0.000001 / 2 = 0.0000005 → rounds to 0.000001 (half away)
  assert.equal(divMicros(1n, 2000000n), 1n);
  assert.equal(divMicros(-1n, 2000000n), -1n);
});

test("decimal: detectNumberFormat uses evidence and rejects mixed", () => {
  assert.equal(detectNumberFormat(["1.234,56", "10,00-"], "standard"), "greek");
  assert.equal(detectNumberFormat(["1,234.56", "(5.00)"], "greek"), "standard");
  assert.equal(detectNumberFormat(["123", "456"], "greek"), null);
  assert.throws(() => detectNumberFormat(["1.234,56", "1,234.56"], "standard"), /mixes/);
});

test("encoding: UTF-8, BOM, CP1253 Greek, and ambiguity", () => {
  const utf8 = detectEncodingAndDecode("a.csv", new TextEncoder().encode("a,b\n1,2\n"));
  assert.equal(utf8.encoding, "utf-8");
  const bom = detectEncodingAndDecode("b.csv", new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
  assert.equal(bom.encoding, "utf-8-bom");
  assert.equal(bom.text, "a");
  const greek = detectEncodingAndDecode("c.txt", encodeCp1253("ΙΣΟΖΥΓΙΟ ΛΟΓΑΡΙΑΣΜΩΝ"));
  assert.equal(greek.encoding, "cp1253");
  assert.ok(greek.text.includes("ΙΣΟΖΥΓΙΟ"));
  // CP1253-decodable but with too few Greek letters → ambiguous, refuse to guess
  assert.throws(
    () => detectEncodingAndDecode("d.txt", new Uint8Array([0x61, 0xe1, 0x62])),
    /EncodingAmbiguityError|cannot be asserted/,
  );
});

test("delimiter sniffing: consistent delimiter wins, ambiguity raises", () => {
  assert.equal(sniffDelimiter("x", "a,b,c\n1,2,3\n4,5,6\n"), ",");
  assert.equal(sniffDelimiter("x", "a;b;c\n1;2;3\n"), ";");
  assert.equal(sniffDelimiter("x", "a\tb\n1\t2\n"), "\t");
  assert.throws(() => sniffDelimiter("x", "plain text lines\nwith no structure\n"), /delimiter/i);
});

test("header detection: numeric or duplicate first rows are rejected", () => {
  assertHeaderRow("x", ["Account", "Amount"]);
  assert.throws(() => assertHeaderRow("x", ["123", "456"]), /numeric/);
  assert.throws(() => assertHeaderRow("x", ["A", "A"]), /duplicate/);
  assert.throws(() => assertHeaderRow("x", ["only"]), /at least 2/);
});

test("normKey: smart mode joins digit codes on digits, leading zeros stripped", () => {
  assert.equal(normKey("20-01040000", "smart"), "2001040000");
  assert.equal(normKey("031", "smart"), "31");
  assert.equal(normKey("  Mixed Case ", "smart"), "mixed case");
  assert.equal(normKey("20-01", "raw"), "20-01");
});

test("jaroWinkler: sane similarity ordering", () => {
  assert.equal(jaroWinkler("amount", "amount"), 1);
  const close = jaroWinkler("amount eur", "sum amount");
  const far = jaroWinkler("amount eur", "product code");
  assert.ok(close > far);
  assert.ok(jaroWinkler("account", "gl account") > 0.5);
});
