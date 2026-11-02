#!/usr/bin/env node
/**
 * 進捗が途絶えた Run が `errored` になることを確かめる。
 *
 * 背景: Workflow 側の1断片ごとの上限（CHUNK_TIMEOUT_MS = 180秒）が捕まえるのは
 * 「読者が遅い」だけで、**step の実行そのものが消えた場合には効かない**。例外が
 * 起きないので誰も errored を書かず、Run は `running` のまま残る。実際に、開発
 * サーバーのホットリロードで中断された Run が8時間後も `running` / `entries: 0`
 * のままだった（Workflow engine は消えた step を再実行しなかった）。
 *
 * そこで、その中断をそのまま再現する: 読者の応答を待っている最中にランタイムを
 * 落とし、同じ状態ディレクトリで立て直して、DO のアラームが Run を errored に
 * するかを見る。偽読者の遅延は step を確実に in-flight にするためだけにある。
 *
 *   node tools/verify-stall-watchdog.mjs [--port 8790] [--fake-port 9998] [--stall 6000]
 *
 * 鍵は要らない。実サーバー（8787 など）には触らない。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(option("port", "8790"));
const fakePort = Number(option("fake-port", "9998"));
const stallMs = Number(option("stall", "6000"));
const base = `http://127.0.0.1:${port}`;

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

/** プロセス群ごと落とせるよう、必ず自分のプロセスグループで起こす。 */
function launch(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: new URL("..", import.meta.url).pathname,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}

function kill(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // 既に落ちている
  }
}

async function until(probe, tries, everyMs, label) {
  for (let i = 0; i < tries; i++) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // まだ起きていない
    }
    await wait(everyMs);
  }
  throw new Error(`${label} が待っても来ない`);
}

// wrangler の設定・キャッシュを利用者のホームに書かせない（実行中の dev と同じ扱い）。
const cacheHome = new URL("../../../.cache", import.meta.url).pathname;
const wranglerEnv = {
  XDG_CONFIG_HOME: join(cacheHome, "config"),
  XDG_DATA_HOME: join(cacheHome, "data"),
  XDG_CACHE_HOME: join(cacheHome, "xdg"),
};

const stateDir = mkdtempSync(join(tmpdir(), "rr-stall-"));

function startWorker() {
  return launch(
    "../../node_modules/.bin/wrangler",
    [
      "dev",
      // remote binding（AI）を切る。これが無いと鍵を要求されて起動しない。
      // この試験は読者もモデルも使わないので、ローカルだけで足りる。
      "--local",
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--persist-to", stateDir,
      "--var", "READER_KIND:gateway",
      "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${fakePort}`,
      "--var", "ANTHROPIC_MODEL:fake-reader-1",
      // 本番は7分。ここを短くしないと試験が7分かかる。
      "--var", `STALL_MS:${stallMs}`,
    ],
    wranglerEnv,
  );
}

const healthy = () => fetch(`${base}/healthz`).then((response) => response.ok).catch(() => false);
const state = (token) => fetch(`${base}/api/runs/${token}/state`).then((response) => response.json());
const limits = () => fetch(`${base}/api/limits`).then((response) => response.json());

const manuscript = [
  "見出し1\n\n第一段落です。読者が応答を返す前にランタイムを落とします。",
  "見出し2\n\n第二段落です。ここまで到達しないはずです。",
  "見出し3\n\n第三段落です。ここも到達しません。",
].join("\n\n");

try {
  // 偽読者。断片1つぶんの応答を stall より長く遅らせ、step を in-flight に留める。
  launch("node", ["tools/fake-anthropic.mjs", "--port", String(fakePort), "--delay", String(stallMs * 4), "--log", join(stateDir, "fake.jsonl")]);
  const worker = startWorker();
  worker.stderr.on("data", () => {});
  await until(healthy, 120, 500, "1台目の起動");

  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manuscript, lang: "ja", reader: "gateway", paceMs: 0 }),
  }).then((response) => response.json());
  check("Run を受け付ける", Boolean(created.token), JSON.stringify(created).slice(0, 160));
  if (!created.token) throw new Error("Run を作れなかった");
  const token = created.token;

  // 読者を待っている最中であること（ここで entries が増えていたら試験にならない）。
  const before = await state(token);
  check(
    "落とす前は running / 0件",
    ["queued", "running"].includes(before.status) && before.entries.length === 0,
    `${before.status} / ${before.entries.length}件`,
  );
  const busy = await limits();
  check("走行中は枠を1つ使う", busy.active >= 1, JSON.stringify(busy));

  // ここが再現。応答を待っている step ごとランタイムを落とす。例外は起きない。
  kill(worker);
  await until(async () => !(await healthy()), 40, 250, "1台目の停止");

  const restarted = startWorker();
  restarted.stderr.on("data", () => {});
  await until(healthy, 120, 500, "2台目の起動");

  const started = Date.now();
  const stalled = await until(
    async () => {
      const current = await state(token);
      return current.status === "errored" ? current : null;
    },
    Math.ceil((stallMs * 4) / 500),
    500,
    "errored への遷移",
  );
  const took = Date.now() - started;

  check("中断された Run が errored になる", stalled.status === "errored", `${Math.round(took / 1000)}秒で検出`);
  check("止まった理由が記録される", /進捗/.test(stalled.reason ?? ""), JSON.stringify(stalled.reason ?? ""));
  check("記録は0件のまま（読めていない）", stalled.entries.length === 0, `${stalled.entries.length}件`);

  const after = await limits();
  check("止まった Run は枠を返す", after.active < busy.active, `${busy.active} → ${after.active}`);

  // 結果ページに理由が出ること（画面まで届かないと「真っ白」は直っていない）。
  const page = await fetch(`${base}/r/${token}/result`).then((response) => response.text());
  check("結果ページに理由が出る", page.includes("進捗がありません"), `${page.length}字`);
} finally {
  for (const child of children) kill(child);
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nNG: ${failures.length}件` : "\nすべて通った");
process.exit(failures.length ? 1 : 0);
