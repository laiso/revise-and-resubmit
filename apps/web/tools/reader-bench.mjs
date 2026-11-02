#!/usr/bin/env node
/**
 * 読者としての適性を測る台（docs/implementation-plan.md フェーズ3）。
 *
 * Cloudflare の Worker も DO も Workflow も通さない。分割・プロンプト組み立て・
 * パースは packages/core を使い、送信だけを AI Gateway の統一形（OpenAI 互換）に
 * 差し替える。dev サーバーを共有したことによる測定汚染を避けるため。
 *
 *   node tools/reader-bench.mjs --run readme-02 --model anthropic/claude-sonnet-5
 *
 * 判定は「修正率がアーカイブの帯に入るか」。note-01 のアーカイブ（Sonnet）は 24%。
 * 数字は必要条件であって十分条件ではない。中身は目で読むこと。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chunk, buildReaderSystem, buildReaderMessages, parseReaderNote, MIND_TAIL_PERSONA } from "@revise-and-resubmit/core";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const fixture = option("run", "readme-02");
const model = option("model", "anthropic/claude-sonnet-5");
const limit = Number(option("limit", "0"));
const out = option("out", "");
const account = readFileSync(option("account-file"), "utf8").trim();
const token = readFileSync(option("token-file"), "utf8").trim();
const endpoint = `https://gateway.ai.cloudflare.com/v1/${account}/default/compat/chat/completions`;

const source = readFileSync(new URL(`../../../.revise-and-resubmit/${fixture}/source.md`, import.meta.url), "utf8");
const chunks = chunk(source, "ja");
const served = limit > 0 ? chunks.slice(0, limit) : chunks;

// OpenAI の新しいモデルは max_tokens を受け付けない。統一形でもここは揃わない。
const budgetKey = model.startsWith("openai/") ? "max_completion_tokens" : "max_tokens";

async function ask(messages) {
  const body = {
    model,
    [budgetKey]: 4096,
    messages: [{ role: "system", content: buildReaderSystem(MIND_TAIL_PERSONA) }, ...messages],
  };
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "cf-aig-authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  const choice = parsed.choices?.[0];
  return {
    text: (choice?.message?.content ?? "").trim(),
    finish: choice?.finish_reason ?? "",
    usage: parsed.usage ?? {},
    ms: Date.now() - started,
  };
}

const notes = [];
const rows = [];
for (let i = 0; i < served.length; i++) {
  const messages = buildReaderMessages([
    ...notes.map((note, index) => ({ index, total: served.length, chunk: served[index], lang: "ja", note })),
    { index: i, total: served.length, chunk: served[i], lang: "ja" },
  ]);
  let reply;
  try {
    reply = await ask(messages);
  } catch (error) {
    rows.push({ idx: i, error: String(error).slice(0, 200) });
    break;
  }
  const note = parseReaderNote(reply.text, i);
  notes.push(note);
  rows.push({ idx: i, ...reply, note });
  process.stdout.write(
    `#${String(i + 1).padStart(2)} ${String(reply.ms).padStart(6)}ms ${reply.finish.padEnd(10)} ` +
      `${note.structured ? "構造化" : "自由文  "} ${(note.understanding || "").slice(0, 48)}\n`,
  );
  if (note.stop) {
    process.stdout.write("   （読者が停止を申告）\n");
    break;
  }
}

const done = rows.filter((row) => row.note);
const substantive = (value) => Boolean(value) && !/^(なし|無し|特になし|とくになし|－|—|-)/.test(value.trim());
const revisions = done.filter((row) => substantive(row.note.revision)).length;
const unresolved = done.filter((row) => substantive(row.note.unresolved)).length;
const unstructured = done.filter((row) => !row.note.structured).length;
const times = done.map((row) => row.ms).sort((a, b) => a - b);
const median = times.length ? times[Math.floor(times.length / 2)] : 0;
const tokensIn = done.reduce((sum, row) => sum + (row.usage.prompt_tokens ?? 0), 0);
const tokensOut = done.reduce((sum, row) => sum + (row.usage.completion_tokens ?? 0), 0);

const summary = {
  fixture,
  model,
  chunks: served.length,
  completed: done.length,
  revisionRate: done.length ? Math.round((revisions / done.length) * 100) : 0,
  unresolvedRate: done.length ? Math.round((unresolved / done.length) * 100) : 0,
  unstructured,
  medianMs: median,
  maxMs: times.length ? times[times.length - 1] : 0,
  tokensIn,
  tokensOut,
  error: rows.find((row) => row.error)?.error ?? null,
};

console.log("\n" + JSON.stringify(summary, null, 2));
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  console.log(`saved: ${out}`);
}
