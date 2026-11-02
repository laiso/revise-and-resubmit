#!/usr/bin/env node
/**
 * 実モデル（AI Gateway 経由）で1本走らせ、記録された usage から実費を出す。
 *
 *   node tools/run-real.mjs --base http://127.0.0.1:8787            # note-01（17断片）
 *   node tools/run-real.mjs --synthetic 2                           # 自前の短い原稿（smoke）
 *
 * 事前に dev サーバーを Gateway 向けの環境変数つきで起動しておくこと:
 *   ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/anthropic
 *   ANTHROPIC_MODEL=claude-sonnet-5 / AI_GATEWAY_TOKEN=... / READER_BETA=...
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option("base", "http://127.0.0.1:8787");
const paceMs = Number(option("pace", "0"));
const synthetic = option("synthetic", null);
const fixture = option("run", "note-01");
const readerMode = option("reader", null); // workers-ai | gateway | null（サーバーの既定）
const readerModel = option("model", null); // 例: @cf/meta/llama-3.1-8b-instruct

let manuscript;
if (synthetic !== null) {
  const count = Math.min(48, Math.max(1, Number(synthetic)));
  manuscript = Array.from(
    { length: count },
    (_, index) => `段落${index + 1}の見出し\n\nこれは実測用の段落${index + 1}です。読者はここで立ち止まり、理解を書き残します。`,
  ).join("\n\n");
} else {
  const archive = new URL(`../../../.revise-and-resubmit/${fixture}/`, import.meta.url);
  manuscript = readFileSync(new URL("source.md", archive), "utf8");
}

const created = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    manuscript,
    lang: "ja",
    paceMs,
    ...(readerMode ? { reader: readerMode } : {}),
    ...(readerModel ? { readerModel } : {}),
  }),
}).then((response) => response.json());
if (!created.token) {
  console.error("create failed:", created);
  process.exit(1);
}
console.log(`run ${created.token}: ${created.chunks} chunks, model=${created.model}`);
console.log(`live:   ${base}${created.url}`);
console.log(`result: ${base}${created.url}/result\n`);

const started = Date.now();
let state = null;
for (let i = 0; i < 2400; i++) {
  state = await fetch(`${base}/api/runs/${created.token}/state`).then((response) => response.json());
  if (["complete", "stopped", "errored"].includes(state.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const tokens = (usage, key) => Number(usage?.[key] ?? 0);
let cost = 0;
let input = 0;
let output = 0;
let cacheWrite = 0;
let cacheRead = 0;
for (const entry of state.entries) {
  const usage = entry.usage;
  input += tokens(usage, "input_tokens");
  output += tokens(usage, "output_tokens");
  cacheWrite += tokens(usage, "cache_creation_input_tokens");
  cacheRead += tokens(usage, "cache_read_input_tokens");
  cost += (tokens(usage, "input_tokens") * 2 + tokens(usage, "cache_creation_input_tokens") * 2 * 1.25 + tokens(usage, "cache_read_input_tokens") * 2 * 0.1 + tokens(usage, "output_tokens") * 10) / 1e6;
  const head = (entry.entry || "").split("\n")[0].slice(0, 64);
  console.log(`#${String(entry.idx + 1).padStart(2)} ${entry.model.padEnd(16)} in=${String(tokens(usage, "input_tokens")).padStart(5)} out=${String(tokens(usage, "output_tokens")).padStart(5)} cw=${String(tokens(usage, "cache_creation_input_tokens")).padStart(5)} cr=${String(tokens(usage, "cache_read_input_tokens")).padStart(5)}  ${head}`);
}

console.log(`\nstatus=${state.status}  entries=${state.entries.length}/${state.total}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`tokens: input=${input} output=${output} cache_write=${cacheWrite} cache_read=${cacheRead}`);
const claude = state.entries.every((entry) => /claude/.test(entry.model));
console.log(
  claude
    ? `実費（Sonnet 5 $2/$10、cache write 1.25x / read 0.1x）: $${cost.toFixed(4)}`
    : "Workers AI はニューロン課金なので $ は出さない（コンソールで確認）。トークン数だけ記録した。",
);
