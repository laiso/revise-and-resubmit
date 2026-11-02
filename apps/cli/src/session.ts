/*
 * Derived from awesome-llm-apps/agent_skills/first-reader (Apache-2.0).
 * Modified by laiso. Ported from the file-mode half of
 * `skills/revise-and-resubmit/scripts/feed.py` (decision record 0004).
 *
 * The fallback for when a reader cannot reach a served feed: the same passages
 * and the same log, kept in a session directory instead of in a process.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Lang, chunk, chunkFooter, chunkHeader, count, unit, BRIEFING } from "@revise-and-resubmit/core";

import type { LogRecord } from "./feed.ts";

export interface SessionState {
  draft: string;
  persona: string;
  chunks: string[];
  cursor: number;
  done: boolean;
  started: number;
  quit_at?: number | null;
  final_logged?: boolean;
  language?: Lang;
}

export function load(directory: string): SessionState {
  return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as SessionState;
}

export function save(directory: string, state: SessionState): void {
  writeFileSync(join(directory, "state.json"), JSON.stringify(state, null, 2));
}

export function entries(directory: string): LogRecord[] {
  return readFileSync(join(directory, "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LogRecord);
}

export function show(state: SessionState, index: number, command: string): string {
  const lang = state.language ?? "en";
  return [chunkHeader(index, state.chunks, lang), state.chunks[index], chunkFooter(command)].join("\n");
}

export function record(directory: string, state: SessionState, entry: string, quit = false): void {
  if (!entry.trim()) {
    throw new Error("REFUSED: A log entry is required before advancing or stopping.");
  }
  const total = state.chunks?.length ?? 0;
  const rec: LogRecord = {
    chunk: total ? Math.min(state.cursor + 1, total) : state.cursor + 1,
    quit,
    entry: entry.trim(),
    t: Date.now() / 1000,
  };
  appendFileSync(join(directory, "log.jsonl"), `${JSON.stringify(rec)}\n`);
}

export function startSession(
  directory: string,
  draftPath: string,
  text: string,
  persona: string | undefined,
  lang: Lang,
  command: string,
): string {
  if (existsSync(directory)) throw new Error(`Session already exists: ${directory}`);
  const chunks = chunk(text, lang);
  const state: SessionState = {
    draft: draftPath,
    persona: persona || "unnamed",
    chunks,
    cursor: 0,
    done: false,
    started: Date.now() / 1000,
  };
  if (lang !== "en") state.language = lang;
  mkdirSync(directory, { recursive: true });
  save(directory, state);
  writeFileSync(join(directory, "log.jsonl"), "");
  return [
    `SESSION ${directory} | persona: ${state.persona} | ${chunks.length} chunks, ` +
      `${count(text, lang)} ${unit(lang)} total`,
    BRIEFING,
    show(state, 0, command),
  ].join("\n");
}

export function transcript(directory: string): string {
  const state = load(directory);
  const lines = [
    `READING TRANSCRIPT | persona: ${state.persona} | ` +
      `${!state.quit_at ? "finished" : `QUIT at chunk ${state.quit_at}`}` +
      ` of ${state.chunks.length} chunks`,
  ];
  const log = entries(directory);
  log.forEach((e, i) => {
    const final = i === log.length - 1 && state.done && !state.quit_at;
    const mark = e.quit ? "QUIT " : final ? "FINAL " : "";
    lines.push(`[chunk ${e.chunk}] ${mark}${e.entry}`);
  });
  return lines.join("\n");
}

export function status(directory: string): string {
  const state = load(directory);
  return (
    `persona=${state.persona} ` +
    `cursor=${Math.min(state.cursor + 1, state.chunks.length)}/${state.chunks.length} ` +
    `done=${state.done} quit_at=${state.quit_at ?? null}`
  );
}
