#!/usr/bin/env node
/**
 * 読者パス（Gateway 経由の実モデル呼び出し）を、鍵なしで偽 Messages API に対して検証する。
 *
 *   1. 偽サーバを起動して wrangler dev を `--var ANTHROPIC_BASE_URL:http://127.0.0.1:9999`
 *      `--var ANTHROPIC_MODEL:fake-reader-1`
 *      `--var READER_FALLBACK_MODEL:fake-reader-fallback` で動かす。
 *      偽サーバは model をそのまま返すので名前は何でもよいが、許可リスト
 *      （src/models.ts）に載っているものでないと入稿で断られる。
 *   2. node tools/verify-gateway-reader.mjs [--base http://127.0.0.1:8787] [--fake http://127.0.0.1:9999]
 *
 * 見るもの: 構造化された記録が保存されること / 未提示の本文がプロンプトに混ざらないこと /
 * refusal のときにフォールバックで続くこと / モデルの途中交代が記録されること。
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option("base", "http://127.0.0.1:8787");
const fake = option("fake", "http://127.0.0.1:9999");
const logPath = option("log", ".cache/fake-anthropic.jsonl");

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

const manuscript = [
  "第一段落です。この道具は原稿を少しずつ読者に見せます。",
  "第二段落です。読者はそこで立ち止まり、理解を書き残します。",
  "第三段落です。書き残した内容は、その時点で何が分からなかったかを示します。",
  "第四段落です。別の読者は許容できない表現で読むのをやめます。",
]
  .map((paragraph, index) => `段落${index + 1}の見出し\n\n${paragraph}`)
  .join("\n\n");

const chunks = manuscript.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);

async function fakeControl(path, body) {
  const response = await fetch(`${fake}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return response.json();
}

async function run(reader, paceMs = 0) {
  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manuscript, lang: "ja", paceMs, reader }),
  }).then((response) => response.json());
  if (!created.token) throw new Error(`create failed: ${JSON.stringify(created)}`);
  for (let i = 0; i < 60; i++) {
    const state = await fetch(`${base}/api/runs/${created.token}/state`).then((response) => response.json());
    if (state.status === "complete" || state.status === "stopped" || state.status === "errored") return { created, state };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("run did not settle");
}

// 0. 偽サーバの記録をまっさらにする（前回の実行と混ざらないように）。
await fakeControl("/control/reset", {});

// 1. 通常の読者パス。
const first = await run("gateway");
check("gateway reader produces a complete run", first.state.status === "complete", `status=${first.state.status} (${first.created.model})`);
check("every chunk got a record", first.state.entries.length === first.state.total, `${first.state.entries.length}/${first.state.total}`);
const entry = first.state.entries[0]?.entry ?? "";
check("records use the archive's log layout", /^理解：/.test(entry) && entry.includes("根拠：") && entry.includes("修正："), entry.split("\n")[0].slice(0, 30));
check("a revision moment was recognised", first.state.entries.some((row) => /修正：/.test(row.entry) && !/修正：\s*(なし|無し)/.test(row.entry)));
check("the model that answered is recorded", first.state.entries.every((row) => row.model.length > 0), first.state.entries[0]?.model);

// 2. プロンプト側の検査（偽サーバが残した全文から）。
const captured = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const firstRun = captured.slice(0, first.state.total);
check("the beta header reached the provider", firstRun.every((row) => row.beta === "server-side-fallback-2026-07-01"), firstRun[0]?.beta ?? "-");
check("automatic caching is requested", firstRun.every((row) => row.hasCacheControl === true));
check("fallbacks:default is sent", firstRun.every((row) => row.fallbacks === "default"));
check(
  "the conversation alternates user/assistant turns",
  firstRun.every((row, index) => row.roles.length === index * 2 + 1 && row.roles.every((role, at) => role === (at % 2 === 0 ? "user" : "assistant"))),
  firstRun.at(-1)?.roles.join(","),
);
check(
  "the cacheable prefix grows with each turn",
  firstRun.every((row, index) => index === 0 ? row.prefixChars === 0 : row.prefixChars > firstRun[index - 1].prefixChars),
  firstRun.map((row) => row.prefixChars).join(" → "),
);

// 各リクエストのプロンプトに、その時点で未提示の断片が混ざっていないこと。
// 断片列は「実際に提示されたもの」（完了後の state）を使う。素朴な空行分割では
// 分割規則（最初の3文を1文ずつ）を再現できない。
const realChunks = first.state.entries.map((row) => row.text);
let leaked = null;
for (const row of firstRun) {
  const current = realChunks[row.chunkIndex - 1] ?? "";
  if (!current) continue;
  if (!row.lastUser.includes(current)) leaked = { index: row.chunkIndex, text: "current chunk missing" };
  for (const later of realChunks.slice(row.chunkIndex)) {
    if (later && row.allText.includes(later)) leaked = { index: row.chunkIndex, text: later.slice(0, 20) };
  }
}
check("no prompt carries text that was not yet served", leaked === null, leaked ? JSON.stringify(leaked) : `checked ${firstRun.length} prompts against ${realChunks.length} chunks`);
check("the reader's own earlier notes are carried forward", firstRun.at(-1).allText.includes("第1断片を読んだ"));

// 3. refusal のとき、フォールバックモデルで続くこと。
await fakeControl("/control/refuse", { count: 1 });
const refused = await run("gateway");
const models = new Set(refused.state.entries.map((row) => row.model));
check("a refusal does not stop the run", refused.state.status === "complete", `status=${refused.state.status}`);
check("every chunk still has a record", refused.state.entries.length === refused.state.total, `${refused.state.entries.length}/${refused.state.total}`);
check(
  "the fallback model took over after the refusal",
  models.has("fake-reader-fallback"),
  [...models].join(", "),
);
check("the substituted model is visible per entry", refused.state.entries[0]?.model === "fake-reader-fallback", refused.state.entries[0]?.model);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nall reader-path checks passed");
process.exit(failures.length ? 1 : 0);
