#!/usr/bin/env node
/**
 * 受付の枠（`__limits__` DO の gate 表）が、Run の終了で返ることを確かめる。
 *
 * 背景: 以前は終了の記帳をせず「直近10分に始まった Run」を走行中と数えていた。
 * そのため (1) 終わった Run が10分ぶん枠を占有し、続けて走らせると全部終わって
 * いても 429 になる、(2) 10分を超える Run（Qwen の実測19.2分）が走行中と
 * 数えられず上限が効かない、という2つの穴があった。今は `ended_at` に記帳し、
 * 時間切れ（ACTIVE_WINDOW_MS）は記帳漏れの保険としてだけ残している。
 *
 *   node tools/verify-gate-release.mjs [--base http://127.0.0.1:8787]
 *
 * モックの Run しか使わないので、鍵も偽サーバも要らない。
 */
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option("base", "http://127.0.0.1:8787");

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

const limits = () => fetch(`${base}/api/limits`).then((response) => response.json());

const manuscript = [
  "第一段落です。受付の枠が返ることを確かめます。",
  "第二段落です。走行中は枠を1つ使います。",
  "第三段落です。終わったら枠を返します。",
]
  .map((paragraph, index) => `段落${index + 1}の見出し\n\n${paragraph}`)
  .join("\n\n");

const mockEntries = ["理解：第1断片を読んだ。", "理解：第2断片を読んだ。", "理解：第3断片を読んだ。"];

async function create(paceMs) {
  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manuscript, lang: "ja", reader: "mock", mockEntries, paceMs }),
  }).then((response) => response.json());
  if (!created.token) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.token;
}

async function state(token) {
  return fetch(`${base}/api/runs/${token}/state`).then((response) => response.json());
}

async function waitTerminal(token, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const current = await state(token);
    if (["complete", "stopped", "errored", "deleted"].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${token} が終わらない`);
}

const baseline = await limits();
check("/api/limits が本数と上限を返す", Number.isFinite(baseline.active) && Number.isFinite(baseline.maxActive), JSON.stringify(baseline));

// 走行中は枠を使う（「常に0」で通ってしまわないことの確認）。
const paced = await create(2000);
await new Promise((resolve) => setTimeout(resolve, 700));
const during = await limits();
check("走行中の Run は枠を使う", during.active > baseline.active, `active=${during.active} (基準 ${baseline.active})`);

const pacedState = await waitTerminal(paced);
check("モックの Run が完走する", pacedState.status === "complete", `status=${pacedState.status}`);

const afterComplete = await limits();
check(
  "完走した Run は枠を返す",
  afterComplete.active === baseline.active,
  `active=${afterComplete.active} (基準 ${baseline.active})`,
);
check(
  "枠を返しても今日の件数は減らない",
  afterComplete.today === baseline.today + 1,
  `today=${afterComplete.today} (基準 ${baseline.today})`,
);

// 削除でも枠を返す。
const doomed = await create(0);
const deleted = await fetch(`${base}/api/runs/${doomed}/delete`, { method: "POST" }).then((response) => response.json());
check("削除が通る", deleted.deleted === true, JSON.stringify(deleted));
const afterDelete = await limits();
check(
  "削除した Run は枠を返す",
  afterDelete.active === baseline.active,
  `active=${afterDelete.active} (基準 ${baseline.active})`,
);

console.log(failures.length === 0 ? `\nすべて通った (${7} 件)` : `\n${failures.length} 件が失敗`);
process.exit(failures.length === 0 ? 0 : 1);
