/*
 * Derived from awesome-llm-apps/agent_skills/first-reader (Apache-2.0).
 * Modified by laiso. Ported from `skills/revise-and-resubmit/scripts/ask.py`
 * (decision record 0004).
 *
 * Builds the bundle a follow-up question is answered from: one reader's own
 * recorded notes and nothing else. The manuscript is deliberately absent, so an
 * experience that was never written down stays unrecorded instead of invented.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { entries, load } from "./session.ts";

export function bundle(runDir: string, name: string, question: string): string | null {
  const directory = join(runDir, name);
  if (!existsSync(join(directory, "state.json"))) return null;
  const state = load(directory);
  const log = entries(directory)
    .map((e) => `[passage ${e.chunk}] ${e.quit ? "QUIT " : ""}${e.entry}`)
    .join("\n");
  const how = state.quit_at
    ? `stopped at passage ${state.quit_at} of ${state.chunks.length}`
    : `finished all ${state.chunks.length} passages`;
  return (
    `You are ${state.persona}. In the recorded session you read a piece one passage at a time and ${how}. ` +
    `Use only the following recorded observations ` +
    `from that session:\n\n${log}\n\nThe author asks you: ${question}\n\n` +
    `Answer as yourself, in under 150 words, grounded only in what you noted at the time. Quote your own ` +
    `notes where they answer it. Do not invent details of the text you did not note. If the log does not ` +
    `support an answer, say 'I can't say; I didn't note it at the time.' Never suggest rewrites; say what ` +
    `happened to you and what would have had to be true for it to go differently.`
  );
}

export function ask(runDir: string, who: string, question: string): string {
  const names =
    who === "all"
      ? readdirSync(runDir)
          .filter((name) => existsSync(join(runDir, name, "state.json")))
          .sort()
      : [who];
  const out: string[] = [];
  for (const name of names) {
    const value = bundle(runDir, name, question);
    if (value === null) throw new Error(`no reader '${name}' under ${runDir}`);
    out.push(`===== reader: ${name} =====\n${value}`);
  }
  return out.join("\n\n");
}
