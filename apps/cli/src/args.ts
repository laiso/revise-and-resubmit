/**
 * A small argv reader. The flag names come from the Python scripts this CLI
 * replaced, so a habit learned on `feed.py` still works (decision record 0004).
 */

export interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

export class UsageError extends Error {}

/** Flags that take no value. */
const BOOLEAN = new Set(["--open-browser", "--help", "-h"]);

export function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") && token !== "-h") {
      positional.push(token);
      continue;
    }
    let name = token;
    let value: string | undefined;
    const eq = token.indexOf("=");
    if (eq > 0) {
      name = token.slice(0, eq);
      value = token.slice(eq + 1);
    }
    if (BOOLEAN.has(name)) {
      if (value !== undefined) throw new UsageError(`${name} takes no value`);
      flags.set(name, ["true"]);
      continue;
    }
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      i += 1;
    }
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  }
  return { positional, flags };
}

export function flag(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

export function flagAll(parsed: Parsed, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

export function bool(parsed: Parsed, name: string): boolean {
  return parsed.flags.has(name);
}

export function number(parsed: Parsed, name: string, fallback: number): number {
  const raw = flag(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${name} must be a number, got ${raw}`);
  return value;
}

export function lang(parsed: Parsed): "en" | "ja" {
  const raw = flag(parsed, "--lang") ?? "en";
  if (raw !== "en" && raw !== "ja") throw new UsageError("--lang must be en or ja");
  return raw;
}
