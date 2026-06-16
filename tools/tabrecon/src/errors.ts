/**
 * Every tabrecon error carries a stable name printed as
 * `error(<Name>): <message>` — the agent-facing error contract.
 */

export class UsageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UsageError";
  }
}

export class ConfigError extends Error {
  constructor(setting: string, envVar: string, flag: string) {
    super(
      `Required setting "${setting}" was not provided — set env ${envVar}, ` +
        `a line in ~/.tool-agents/tabrecon/.env or ./.env, or pass ${flag}. ` +
        `No fallback is substituted.`,
    );
    this.name = "ConfigError";
  }
}

export class EncodingAmbiguityError extends Error {
  constructor(file: string, detail: string) {
    super(`Cannot determine the text encoding of "${file}": ${detail}. Refusing to guess.`);
    this.name = "EncodingAmbiguityError";
  }
}

export class DelimiterAmbiguityError extends Error {
  constructor(file: string, detail: string) {
    super(
      `Cannot determine the delimiter of "${file}": ${detail}. ` +
        `Provide a parse spec (--spec) describing the layout.`,
    );
    this.name = "DelimiterAmbiguityError";
  }
}

export class HeaderDetectionError extends Error {
  constructor(file: string, detail: string) {
    super(
      `Cannot identify a header row in "${file}": ${detail}. ` +
        `Provide a parse spec (--spec) naming the columns.`,
    );
    this.name = "HeaderDetectionError";
  }
}

export class UnrecognizedFormatError extends Error {
  constructor(file: string, detail: string) {
    super(`Cannot classify "${file}" as a supported tabular format: ${detail}.`);
    this.name = "UnrecognizedFormatError";
  }
}

export class ParseSpecError extends Error {
  constructor(detail: string) {
    super(`Invalid parse spec: ${detail}`);
    this.name = "ParseSpecError";
  }
}

export class NumberFormatError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NumberFormatError";
  }
}

export class DriftError extends Error {
  constructor(profileName: string, drifts: string[]) {
    super(
      `Hard schema drift against profile "${profileName}": ${drifts.join("; ")}. ` +
        `The file was NOT ingested. Re-point mappings or ingest under a new profile (--profile).`,
    );
    this.name = "DriftError";
  }
}

export class ManyToManyKeyError extends Error {
  constructor(keyDesc: string, pairs: number, cap: number) {
    super(
      `Key ${keyDesc} pairs ${pairs} raw row combinations (cap ${cap}) at the finest mapped level — ` +
        `the join key is too coarse; add a finer key level to the mapping.`,
    );
    this.name = "ManyToManyKeyError";
  }
}

export class SchemaMismatchError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SchemaMismatchError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string, key: string) {
    super(`${what} "${key}" not found in this database`);
    this.name = "NotFoundError";
  }
}
