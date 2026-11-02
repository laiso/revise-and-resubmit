/**
 * Where the shared review assets live.
 *
 * `review.html` / `review.css` / `review.js` / `human-feedbox.js` stay inside
 * the skill directory: a generated `room.html` points at them by relative path,
 * so moving them breaks every run directory produced so far (decision record
 * 0004). This module only has to find them from either place the CLI runs from.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ASSET_NAMES = ["review.css", "review.js", "human-feedbox.js"] as const;

/**
 * Candidates in the order they are tried:
 * 1. the bundle's sibling — `<skill>/bin/cli.mjs` next to `<skill>/assets/`
 * 2. the repository checkout, running from `apps/cli/src/`
 */
function candidates(): string[] {
  return [
    fileURLToPath(new URL("../assets/", import.meta.url)),
    fileURLToPath(new URL("../../../skills/revise-and-resubmit/assets/", import.meta.url)),
  ];
}

export function resolveAssets(override?: string): string {
  const tried = override ? [override] : candidates();
  for (const directory of tried) {
    if (existsSync(join(directory, "review.html"))) return directory;
  }
  throw new Error(
    `Could not find the review assets (review.html) in: ${tried.join(", ")}. Pass --assets <dir>.`,
  );
}
