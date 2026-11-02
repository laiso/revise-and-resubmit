#!/usr/bin/env node
/**
 * 配信の機構確認（G6 の前提）: chunk と chunk の間に長い空白があっても、
 * WebSocket は切れず、次の断片が届くか。
 *
 *   node tools/verify-idle-gap.mjs [--base http://127.0.0.1:8787] [--gap 5000]
 *
 * SSE は接続中ずっと in-flight になるため、この空白がそのまま課金対象になる。
 * Hibernation は接続を保持したまま眠れるので、空白をまたいで配信が再開する。
 * ここで見るのは「眠れる設計で接続が生き残るか」という機構の側。
 */
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option("base", "http://127.0.0.1:8787");
const gap = Math.min(10_000, Number(option("gap", "5000")));

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

const manuscript = [
  "第一段落です。ここは最初の断片になります。",
  "第二段落です。空白のあとに届くはずです。",
  "第三段落です。もう一度空白をまたぎます。",
].join("\n\n");

const created = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ manuscript, lang: "ja", paceMs: gap, reader: "mock" }),
}).then((response) => response.json());
check("run created", Boolean(created.token), `${created.chunks} chunks, pace ${gap}ms`);
if (!created.token) process.exit(1);

const arrivals = [];
let closed = null;
const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/runs/${created.token}/ws`);
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "append") arrivals.push({ at: Date.now(), idx: message.entries[0].idx });
});
socket.addEventListener("close", (event) => {
  closed = { at: Date.now(), code: event.code };
});

const started = Date.now();
while (arrivals.length < created.chunks && Date.now() - started < gap * created.chunks + 25_000) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const gaps = arrivals.slice(1).map((entry, index) => entry.at - arrivals[index].at);
const arrived = arrivals.length;

// push は best-effort で落ちうる（DO が起き直した直後など）。落ちても記録は残り、
// snapshot で取り直せること。画面側はこの再同期で自分を直す（live.html）。
let snapshot = null;
const waitSnapshot = new Promise((resolve) => {
  const handler = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      snapshot = message;
      socket.removeEventListener("message", handler);
      resolve();
    }
  };
  socket.addEventListener("message", handler);
  setTimeout(resolve, 3000);
});
socket.send(JSON.stringify({ type: "snapshot" }));
await waitSnapshot;
const state = await fetch(`${base}/api/runs/${created.token}/state`).then((response) => response.json());

console.log(`     push で届いた append: ${arrived}/${created.chunks} / snapshot: ${snapshot?.entries.length ?? "-"} / state: ${state.entries.length}`);
check("every record is written to the run", state.entries.length === created.chunks, `${state.entries.length}/${created.chunks}`);
check(
  "a missed push can be resynced from a snapshot",
  (snapshot?.entries.length ?? 0) === created.chunks,
  `snapshot=${snapshot?.entries.length ?? "-"}`,
);
check("the socket stayed open", closed === null, closed ? `closed at +${closed.at - started}ms code=${closed.code}` : "still open");
check(
  "the gaps were real (not a burst)",
  gaps.length > 0 && gaps.every((value) => value >= gap * 0.6),
  gaps.map((value) => `${Math.round(value)}ms`).join(", "),
);

// 接続したまま Run が完了しても切れないこと。
let status = null;
for (let i = 0; i < 80; i++) {
  status = await fetch(`${base}/api/runs/${created.token}/state`).then((response) => response.json());
  if (status.status === "complete") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check("the run completes with the socket held open", status.status === "complete", `status=${status.status}`);
check("the socket is still open after completion", closed === null);

socket.close();
await fetch(`${base}/api/runs/${created.token}/delete`, { method: "POST" });

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nidle-gap checks passed");
process.exit(failures.length ? 1 : 0);
