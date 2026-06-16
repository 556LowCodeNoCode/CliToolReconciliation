/**
 * Four-tier configuration resolution, lowest to highest priority:
 *   1. shell environment variables
 *   2. ~/.tool-agents/tabrecon/.env
 *   3. ./.env (current working directory)
 *   4. CLI flags
 * A required setting that resolves to nothing raises ConfigError naming the
 * setting, its env var, and its flag. Documented defaults below are part of
 * the tool's published contract — they are applied explicitly, never silently.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "./errors.ts";

export const TOOL_NAME = "tabrecon";

export interface ToolConfig {
  db: string; // documented default: ./recon.db
  schemaOut: string; // documented default: ./tabrecon-schema.md
  tolerance: string; // absolute tolerance, decimal units string; documented default "0.01"
  m2mPairCap: number; // documented default 10000
  failOnFindings: boolean;
  json: boolean;
}

interface SettingDef {
  key: keyof ToolConfig;
  envVar: string;
  flag: string;
}

export const SETTINGS: SettingDef[] = [
  { key: "db", envVar: "TABRECON_DB", flag: "--db" },
  { key: "schemaOut", envVar: "TABRECON_SCHEMA_OUT", flag: "--schema-out" },
  { key: "tolerance", envVar: "TABRECON_TOLERANCE", flag: "--tolerance" },
  { key: "m2mPairCap", envVar: "TABRECON_M2M_PAIR_CAP", flag: "--m2m-pair-cap" },
];

export const DEFAULTS = {
  db: "./recon.db",
  schemaOut: "./tabrecon-schema.md",
  tolerance: "0.01",
  m2mPairCap: 10_000,
} as const;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function positiveInt(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${what} must be a non-negative integer, got "${raw}"`);
  return Number.parseInt(raw, 10);
}

export function resolveConfig(flags: Record<string, string | boolean>): ToolConfig {
  const tiers: Record<string, string>[] = [
    Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    parseEnvFile(join(homedir(), ".tool-agents", TOOL_NAME, ".env")),
    parseEnvFile(join(process.cwd(), ".env")),
  ];

  const resolve = (def: SettingDef): string | undefined => {
    const flagKey = def.flag.slice(2);
    const fv = flags[flagKey];
    if (typeof fv === "string") return fv;
    for (let i = tiers.length - 1; i >= 0; i--) {
      const v = tiers[i]![def.envVar];
      if (v !== undefined && v !== "") return v;
    }
    return undefined;
  };

  const get = (key: keyof ToolConfig): string | undefined =>
    resolve(SETTINGS.find((s) => s.key === key)!);

  const m2mRaw = get("m2mPairCap");
  return {
    db: get("db") ?? DEFAULTS.db,
    schemaOut: get("schemaOut") ?? DEFAULTS.schemaOut,
    tolerance: get("tolerance") ?? DEFAULTS.tolerance,
    m2mPairCap: m2mRaw === undefined ? DEFAULTS.m2mPairCap : positiveInt(m2mRaw, "--m2m-pair-cap"),
    failOnFindings: flags["fail-on-findings"] === true,
    json: flags["json"] === true,
  };
}

/** For settings that have NO default and must be provided (per-command). */
export function requireFlag(
  flags: Record<string, string | boolean>,
  flagKey: string,
  settingName: string,
  envVar = "(flag only)",
): string {
  const v = flags[flagKey];
  if (typeof v !== "string" || v === "") {
    throw new ConfigError(settingName, envVar, `--${flagKey}`);
  }
  return v;
}
