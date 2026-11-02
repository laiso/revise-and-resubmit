#!/usr/bin/env node
/**
 * 骨格の実測（配信・再開・削除、そして「未読を送らない」こと）。
 *
 *   node tools/verify-skeleton.mjs [base] [existing-token]
 *
 * 台本は自前の合成原稿。第三者記事のフィクスチャには依存しない。
 */
const base = process.argv[2] ?? "http://127.0.0.1:8787";
const existing = process.argv[3];

const wsBase = base.replace(/^http/, "ws");
const log = (...args) => console.log(...args);
const failures = [];
function check(label, ok, detail = "") {
  log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
}

function japaneseText(paragraphs) {
  return paragraphs.map((p, i) => `段落${i + 1}の見出し\n\n${p}`).join("\n\n");
}

const body = japaneseText([
  "この道具は原稿を少しずつ読者に見せます。読者はそこで立ち止まり、理解を書き残します。",
  "書き残した内容は、その時点で何が分からなかったかを示します。後から分かっても消しません。",
  "別の読者は、許容できない表現に当たった時点で読むのをやめます。最後まで読むことは目的ではありません。",
  "ログが確定してから、全体を見渡すレビューを一度だけ行います。順序を守らないと後半の説明で前半が汚れます。",
  "結果は引用と指摘だけを残し、全文は残しません。原稿の弱点の記録を公開するものではないからです。",
]);

const created = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ manuscript: body, lang: "ja", paceMs: 1200, reader: "mock" }),
}).then((r) => r.json());
check("run created", Boolean(created.token), `${created.chunks} chunks`);

const token = created.token;
const pageResponse = await fetch(`${base}/r/${token}`);
const page = await pageResponse.text();
check("live page served", pageResponse.status === 200 && page.includes(token));
check("live page is noindex", pageResponse.headers.get("x-robots-tag") === "noindex");
check("live page does not contain the manuscript", !page.includes("この道具は原稿を少しずつ"));

const events = [];
function attach(sink) {
  const socket = new WebSocket(`${wsBase}/api/runs/${token}/ws`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    events.push({ at: Date.now(), type: message.type });
    sink(message);
  });
  return new Promise((resolve) => socket.addEventListener("open", () => resolve(socket)));
}

let firstSnapshot = null;
let seen = 0;
const socketA = await attach((message) => {
  if (message.type === "snapshot" && !firstSnapshot) firstSnapshot = message;
  if (message.type === "append") seen += 1;
});
// 実エッジでは最初の1件に数秒かかる（Workflow の起動 + DO の wake）。固定の窓で判定しない。
const streamDeadline = Date.now() + 15_000;
while (seen < 2 && Date.now() < streamDeadline) {
  await new Promise((r) => setTimeout(r, 250));
}

check(
  "snapshot carries no unread text",
  Boolean(firstSnapshot) &&
    firstSnapshot.entries.length < firstSnapshot.total &&
    firstSnapshot.entries.every((entry, index) => entry.idx === index),
  `entries=${firstSnapshot?.entries.length}/${firstSnapshot?.total}`,
);
check("logs stream incrementally", seen >= 2, `appends=${seen} within 15s`);

socketA.close();

// 再接続（ページを閉じて戻った場合）。snapshot にそれまでの内容が載る。
const resumed = await new Promise((resolve) => {
  let first = null;
  attach((message) => {
    if (message.type === "snapshot" && !first) {
      first = message;
      resolve(message);
    }
  });
});
check("reconnect resumes from the cursor", resumed.entries.length >= seen, `snapshot=${resumed.entries.length} seen=${seen}`);
check("snapshot only carries served chunks", resumed.entries.every((e) => e.idx < resumed.entries.length), `total=${resumed.total}`);
check("snapshot exposes the served text", resumed.entries.every((e) => typeof e.text === "string" && e.text.length > 0));

let state = null;
for (let i = 0; i < 80; i++) {
  state = await fetch(`${base}/api/runs/${token}/state`).then((r) => r.json());
  if (state.status === "complete" || state.status === "stopped") break;
  await new Promise((r) => setTimeout(r, 500));
}
check("run completes", state.status === "complete", `status=${state.status}`);
check("every chunk was served", state.entries.length === state.total, `${state.entries.length}/${state.total}`);
check(
  "chunks are contiguous from zero",
  state.entries.every((entry, index) => entry.idx === index),
);
check(
  "synthetic run has no script, so entries are placeholders",
  state.entries[0].entry.includes("（モック）"),
  state.entries[0].entry.slice(0, 24),
);

const arrivalTimes = new Set(events.filter((e) => e.type === "append").map((e) => e.at));
check("appends were spread over time", arrivalTimes.size >= 2, `${arrivalTimes.size} distinct arrivals`);

// 結果ページ: 引用と指摘だけを載せ、本文を載せない。台本が「」を含まないので引用は無い。
const resultResponse = await fetch(`${base}/r/${token}/result`);
const resultHtml = await resultResponse.text();
check("result page served", resultResponse.status === 200);
check("result page carries no manuscript text", !resultHtml.includes("結果は引用と指摘だけを残し"));
check(
  "result page lists every comment",
  (resultHtml.match(/<article class="card/g) ?? []).length === state.entries.length,
);
check("result page does not invent quotes", resultHtml.includes("（この断片全体について）"));
check("result page offers the live view", resultHtml.includes(`/r/${token}"`));

const deleted = await fetch(`${base}/api/runs/${token}/delete`, { method: "POST" }).then((r) => r.json());
check("delete accepted", deleted.deleted === true);
check("state is gone after delete", (await fetch(`${base}/api/runs/${token}/state`)).status === 404);
check("page is gone after delete", (await fetch(`${base}/r/${token}`)).status === 404);
check("result page is gone after delete", (await fetch(`${base}/r/${token}/result`)).status === 404);

// 読者の停止申告で打ち切る（サーバーが断片数を数えるのではない）。
const stopBody = japaneseText([
  "第一段落です。ここは読み進められます。",
  "第二段落です。ここも読み進められます。",
  "第三段落です。ここで読むのをやめます。",
  "第四段落です。ここは読まれないはずです。",
]);
const stopRun = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    manuscript: stopBody,
    lang: "ja",
    paceMs: 0,
    reader: "mock",
    mockEntries: ["第一段落を読みました。", "第二段落を読みました。", null, "第四段落は読まれないはず。"],
  }),
}).then((r) => r.json());

let stopState = null;
for (let i = 0; i < 40; i++) {
  stopState = await fetch(`${base}/api/runs/${stopRun.token}/state`).then((r) => r.json());
  if (stopState.status === "stopped") break;
  await new Promise((r) => setTimeout(r, 250));
}
check("reader stop halts the run", stopState.status === "stopped", `status=${stopState.status}`);
check("stop is recorded on the entry", stopState.entries.at(-1)?.stop === true);
check("no chunk is served after the stop", stopState.entries.length === 3, `served=${stopState.entries.length}/${stopState.total}`);
check(
  "the unread chunk never appears",
  stopState.entries.every((entry) => !entry.text.includes("第四段落")),
);
await fetch(`${base}/api/runs/${stopRun.token}/delete`, { method: "POST" });

if (existing) {
  const archiveState = await fetch(`${base}/api/runs/${existing}/state`).then((r) => r.json());
  check("archived-fixture run kept its 17 chunks", archiveState.total === 17, `total=${archiveState.total} status=${archiveState.status}`);
  check(
    "archived run replays real logs",
    archiveState.entries[0].entry.startsWith("理解：") && archiveState.entries[0].text.includes("Jev"),
    archiveState.entries[0].entry.slice(0, 18),
  );
  check(
    "archived run has revision moments to show",
    archiveState.entries.filter((entry) => /修正[：:]\s*(?!\s*(なし|無し))/.test(entry.entry)).length >= 3,
  );

  // 実ログには「」の引用がある。結果ページに載った引用は、提示済み本文に実在すること。
  const unescapeHtml = (value) =>
    value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  const archiveResult = await fetch(`${base}/r/${existing}/result`).then((r) => r.text());
  const quotes = [...archiveResult.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/g)].map((match) => unescapeHtml(match[1]));
  check("archived result page shows quotes", quotes.length >= 5, `${quotes.length} quotes`);
  check(
    "every shown quote exists in the served text",
    quotes.every((quote) => archiveState.entries.some((entry) => entry.text.includes(quote))),
  );
  check(
    "archived result page carries no manuscript body",
    !archiveResult.includes("サイコロを振らないという比喩ではなく"),
  );
}

log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
