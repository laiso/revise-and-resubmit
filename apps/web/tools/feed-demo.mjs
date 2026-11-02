#!/usr/bin/env node
/**
 * アーカイブ済み Run の原稿と実ログを「モック読者」として流し込む。
 *
 * 台本は `.revise-and-resubmit/` にあり、このディレクトリは .gitignore 済み
 * （第三者の記事本文を含むためコミットしない）。Anthropic の鍵が無くても、
 * 本物の逐次ログで骨格の見え方を確認できる。
 *
 *   node tools/feed-demo.mjs                 # note-01 を全部流す
 *   node tools/feed-demo.mjs --pace 400      # 断片間の待ちを短く
 *   node tools/feed-demo.mjs --only 6        # 最初の6断片で打ち切る
 *   node tools/feed-demo.mjs --stop-at 12    # 12断片目で読者が離脱する
 *   node tools/feed-demo.mjs --base http://127.0.0.1:8787
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const run = option("run", "note-01");
const base = option("base", "http://127.0.0.1:8787");
const pace = Number(option("pace", "700"));
const only = option("only", null) === null ? null : Number(option("only", null));
const stopAt = option("stop-at", null) === null ? null : Number(option("stop-at", null));

const archive = new URL(`../../../.revise-and-resubmit/${run}/`, import.meta.url);
const source = readFileSync(new URL("source.md", archive), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.json", archive), "utf8"));
const log = readFileSync(new URL("mind-tail/log.jsonl", archive), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

let entries = log.map((record) => (record.quit ? null : record.entry));
if (only !== null) entries = entries.slice(0, only);
if (stopAt !== null) entries = entries.map((entry, index) => (index === stopAt ? null : entry));

const response = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    manuscript: source,
    lang: manifest.language ?? "ja",
    paceMs: pace,
    mockEntries: entries,
    manifest: {
      fixture: run,
      fixture_source: fileURLToPath(archive),
      mock_script: `mind-tail/log.jsonl (${entries.length} entries)`,
    },
  }),
});

const data = await response.json();
if (!response.ok) {
  console.error("failed:", data);
  process.exit(1);
}
console.log(`chunks: ${data.chunks}  model: ${data.model}  pace: ${pace}ms`);
console.log(`live:   ${base}${data.url}`);
console.log(`result: ${base}${data.url}/result`);
