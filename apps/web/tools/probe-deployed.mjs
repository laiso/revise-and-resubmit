#!/usr/bin/env node
/**
 * G4 / G6 の実測（デプロイ後）。`wrangler tail --format json` で invocation ごとの
 * cpuTime を取りながら、デプロイ済み Worker に 1 Run を流す。
 *
 *   node tools/probe-deployed.mjs --selftest                     # パーサと判定の検証（デプロイ不要）
 *   node tools/probe-deployed.mjs --url https://<worker>.workers.dev
 *
 * G4: Workflow の step 呼び出しの cpuTime が Free の 10ms（Paid は30秒）に収まるか。
 * G6: DO の呼び出しが「イベントごとに短く起きる」形になっているか（Hibernation の
 *     ねらいどおりか）。接続時間ぶんの長い 1 リクエストになっていないかを見る。
 *
 * 認証は wrangler の設定（`wrangler auth list` のプロファイル）を使う。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const WRANGLER = fileURLToPath(new URL("../../../node_modules/.bin/wrangler", import.meta.url));
const FREE_STEP_CPU_MS = 10;

/**
 * wrangler tail の出力を読む。`--format json` は **整形された複数行の JSON** を
 * 連結して出す（1行1オブジェクトではない）ので、波括弧の深さで切り出す。
 * 文字列リテラル内の括弧は数えない。
 */
export function parseTailText(text) {
  const items = [];
  let malformed = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          items.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          malformed += 1;
        }
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        malformed += 1;
      }
    }
  }
  // 閉じていない塊も壊れた入力として数える。
  if (depth > 0) malformed += 1;
  return { items, malformed };
}

/** tail の生の行から G4 / G6 の判定材料をまとめる。 */
export function summarizeLines(lines) {
  const { items, malformed } = parseTailText(lines.filter(Boolean).join("\n"));
  return { ...summarize(items), malformed };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

/** 解析済みアイテムから G4 / G6 の判定材料をまとめる。 */
export function summarize(items) {
  const groups = new Map();
  const outcomes = new Map();
  const doItems = [];

  for (const item of items) {
    const outcome = String(item.outcome ?? "unknown");
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);

    const cpu = Number(item.cpuTime ?? 0);
    const wall = Number(item.wallTime ?? 0);
    const isObject = Boolean(item.durableObjectId) || item.event?.type === "hibernatableWebSocket" || item.event?.type === "alarm";
    const name = isObject ? "RunObject (DO)" : String(item.entrypoint || "(http or workflow)");

    if (isObject) doItems.push({ cpu, wall, outcome });
    const group = groups.get(name) ?? { count: 0, cpu: [], wall: [], outcomes: new Map() };
    group.count += 1;
    group.cpu.push(cpu);
    group.wall.push(wall);
    group.outcomes.set(outcome, (group.outcomes.get(outcome) ?? 0) + 1);
    groups.set(name, group);
  }

  const rows = [...groups.entries()]
    .map(([name, group]) => ({
      name,
      count: group.count,
      maxCpu: Math.max(...group.cpu, 0),
      p50Cpu: percentile(group.cpu, 0.5),
      p95Cpu: percentile(group.cpu, 0.95),
      maxWall: Math.max(...group.wall, 0),
      outcomes: Object.fromEntries(group.outcomes),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total: items.length,
    malformed: 0,
    outcomes: Object.fromEntries(outcomes),
    rows,
    doInvocations: doItems.length,
    doTimestamps: items
      .filter((item) => item.durableObjectId)
      .map((item) => Number(item.eventTimestamp))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b),
    doMaxWall: Math.max(0, ...doItems.map((item) => item.wall)),
    doMaxCpu: Math.max(0, ...doItems.map((item) => item.cpu)),
    exceededCpu: (outcomes.get("exceededCpu") ?? 0) + (outcomes.get("exceededResources") ?? 0),
  };
}

/** 区間 [from, to] の中で、隣り合う出来事の最大の間隔。 */
export function largestGap(points, from, to) {
  const inside = points.filter((point) => point >= from && point <= to);
  const marks = [from, ...inside, to].sort((a, b) => a - b);
  let max = 0;
  for (let i = 1; i < marks.length; i++) max = Math.max(max, marks[i] - marks[i - 1]);
  return max;
}

/**
 * G4 / G6 の判定。純粋関数なので selftest で固定できる。
 * `idleWindow` を渡すと「接続を保持したまま DO が眠っていた時間」を測る。
 */
export function judge(summary, options = {}) {
  // tail が1件も返していないなら、測れていない。**PASS と混同しない。**
  if (summary.total === 0) {
    return {
      measured: false,
      g4: { groups: [], freePass: false, paidPass: false, worstMs: 0 },
      g6: { doInvocations: 0, doMaxWallMs: 0, doMaxCpuMs: 0, looksEventDriven: false, longestIdleGapMs: 0, idleWindowMs: 0 },
    };
  }
  const g4 = [];
  for (const row of summary.rows) {
    if (row.name === "RunObject (DO)") continue;
    g4.push({
      group: row.name,
      maxCpuMs: row.maxCpu,
      withinFreeStepLimit: row.maxCpu <= FREE_STEP_CPU_MS,
      withinPaidStepLimit: row.maxCpu <= 30_000,
    });
  }
  const workflow = summary.rows.find((row) => row.name !== "RunObject (DO)");
  const idleWindow = options.idleWindow ?? null;
  const g6 = {
    doInvocations: summary.doInvocations,
    doMaxWallMs: summary.doMaxWall,
    doMaxCpuMs: summary.doMaxCpu,
    // 接続を保持したまま、DO の dispatch が無かった最長の時間。
    // SSE ならこの区間ずっと1リクエストが in-flight になる。
    longestIdleGapMs: idleWindow
      ? largestGap(summary.doTimestamps ?? [], idleWindow.start, idleWindow.end)
      : 0,
    idleWindowMs: idleWindow ? idleWindow.end - idleWindow.start : 0,
    // 接続時間ぶんの長い 1 リクエストなら wall が接続時間に近づく。
    // イベントごとに短く起きる形なら wall は小さいまま呼び出し回数が増える。
    looksEventDriven: summary.doInvocations === 0 || summary.doMaxWall < 5_000,
  };
  return {
    measured: true,
    g4: {
      groups: g4,
      freePass: g4.every((row) => row.withinFreeStepLimit) && summary.exceededCpu === 0,
      paidPass: g4.every((row) => row.withinPaidStepLimit) && summary.exceededCpu === 0,
      worstMs: workflow ? workflow.maxCpu : 0,
    },
    g6,
  };
}

function report(summary, verdict) {
  console.log("group                              n    max cpu   p50    p95    max wall  outcomes");
  for (const row of summary.rows) {
    console.log(
      `${row.name.padEnd(34)} ${String(row.count).padStart(3)}  ${row.maxCpu.toFixed(2).padStart(7)}  ${row.p50Cpu.toFixed(2).padStart(5)}  ${row.p95Cpu.toFixed(2).padStart(5)}  ${String(Math.round(row.maxWall)).padStart(8)}  ${JSON.stringify(row.outcomes)}`,
    );
  }
  console.log(`\ntail items: ${summary.total}（壊れた行 ${summary.malformed}）  outcomes: ${JSON.stringify(summary.outcomes)}`);
  if (!verdict.measured) {
    console.log("\n未計測  tail がイベントを返していません。`wrangler tail` には CLOUDFLARE_API_TOKEN が要ります");
    console.log("        （一時プレビューアカウントでは tail を使えません）。");
    return;
  }
  console.log(
    `\nG4: 最悪 ${verdict.g4.worstMs.toFixed(2)}ms / Free の step 上限 ${FREE_STEP_CPU_MS}ms → ${verdict.g4.freePass ? "PASS（Free で足りる）" : verdict.g4.paidPass ? "Free では不足（Paid の 30 秒枠なら可）" : "FAIL（Paid でも危険）"}`,
  );
  console.log(`G6: DO 呼び出し ${verdict.g6.doInvocations} 回、最長 wall ${Math.round(verdict.g6.doMaxWallMs)}ms、最大 cpu ${verdict.g6.doMaxCpuMs.toFixed(2)}ms`);
  console.log(`    → ${verdict.g6.looksEventDriven ? "イベント駆動に見える（Hibernation のねらいどおり）" : "接続を保持した長い呼び出しがある（SSE 的な形）"}`);
  if (verdict.g6.idleWindowMs > 0) {
    const ratio = verdict.g6.longestIdleGapMs / verdict.g6.idleWindowMs;
    console.log(
      `G6b: 接続を保持したまま ${Math.round(verdict.g6.idleWindowMs / 1000)}s のうち、DO の dispatch が無かった最長 ${Math.round(verdict.g6.longestIdleGapMs / 1000)}s（${Math.round(ratio * 100)}%）`,
    );
    console.log(`    → ${ratio >= 0.8 ? "接続を保ったまま眠っている（SSE なら in-flight のままの区間）" : "眠っていない。接続がオブジェクトを起こし続けている"}`);
  }
}

function selftest() {
  const lines = [
    JSON.stringify({ outcome: "ok", scriptName: "revise-and-resubmit", entrypoint: "default", cpuTime: 2.4, wallTime: 31, logs: [], exceptions: [] }),
    JSON.stringify({ outcome: "ok", scriptName: "revise-and-resubmit", entrypoint: "RunWorkflow", cpuTime: 3.1, wallTime: 480, logs: [], exceptions: [] }),
    JSON.stringify({ outcome: "ok", scriptName: "revise-and-resubmit", entrypoint: "RunWorkflow", cpuTime: 1.2, wallTime: 1200, logs: [], exceptions: [] }),
    JSON.stringify({ outcome: "ok", scriptName: "revise-and-resubmit", durableObjectId: "abc123", cpuTime: 0.6, wallTime: 8, logs: [], exceptions: [] }),
    JSON.stringify({ outcome: "ok", scriptName: "revise-and-resubmit", durableObjectId: "abc123", event: { type: "hibernatableWebSocket" }, cpuTime: 0.2, wallTime: 3, logs: [], exceptions: [] }),
    JSON.stringify({ outcome: "ok", scriptName: "revise-and-resubmit", entrypoint: "RunWorkflow", cpuTime: 12.5, wallTime: 900, logs: [], exceptions: [] }),
    '{"broken": ',
    "not json at all",
    "",
  ];
  const summary = summarizeLines(lines);
  const verdict = judge(summary);
  report(summary, verdict);

  const failures = [];
  const expect = (label, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
    if (!ok) failures.push(label);
  };
  expect("parses json lines and ignores non-json noise", summary.total === 6 && summary.malformed === 1, `total=${summary.total} malformed=${summary.malformed}`);
  expect("separates DO invocations", summary.doInvocations === 2, `do=${summary.doInvocations}`);
  expect("groups by entrypoint", summary.rows.some((row) => row.name === "RunWorkflow" && row.count === 3));
  expect("worst cpu is the slowest step", verdict.g4.worstMs === 12.5, `${verdict.g4.worstMs}`);
  expect("free verdict is negative on a 12.5ms step", verdict.g4.freePass === false);
  expect("paid verdict is positive on a 12.5ms step", verdict.g4.paidPass === true);

  const exceeded = judge(
    summarizeLines([JSON.stringify({ outcome: "exceededCpu", entrypoint: "RunWorkflow", cpuTime: 12.5, wallTime: 900 })]),
  );
  expect("an exceededCpu outcome fails even the paid verdict", exceeded.g4.paidPass === false);

  const fast = judge(summarizeLines([JSON.stringify({ outcome: "ok", entrypoint: "RunWorkflow", cpuTime: 1.8, wallTime: 700 })]));
  expect("a fast step passes the free limit", fast.g4.freePass === true, `${fast.g4.worstMs}ms`);

  expect("event-driven DO looks event-driven", verdict.g6.looksEventDriven === true);

  // 接続を保持したまま眠っていた時間（G6b）。
  const withIdle = judge(
    summarizeLines([
      JSON.stringify({ outcome: "ok", durableObjectId: "x", cpuTime: 1, wallTime: 10, eventTimestamp: 1000 }),
      JSON.stringify({ outcome: "ok", durableObjectId: "x", cpuTime: 1, wallTime: 10, eventTimestamp: 2000 }),
    ]),
    { idleWindow: { start: 2000, end: 62_000 } },
  );
  expect("measures the dispatch-free window", Math.round(withIdle.g6.longestIdleGapMs / 1000) === 60, `${withIdle.g6.longestIdleGapMs}ms`);
  const busy = judge(
    summarizeLines([
      JSON.stringify({ outcome: "ok", durableObjectId: "x", cpuTime: 1, wallTime: 10, eventTimestamp: 2000 }),
      JSON.stringify({ outcome: "ok", durableObjectId: "x", cpuTime: 1, wallTime: 10, eventTimestamp: 32_000 }),
    ]),
    { idleWindow: { start: 2000, end: 62_000 } },
  );
  expect("a dispatch in the middle shortens the gap", Math.round(busy.g6.longestIdleGapMs / 1000) === 30, `${busy.g6.longestIdleGapMs}ms`);

  // 1件も取れていないときは「未計測」。PASS と混同しない。
  const empty = judge(summarizeLines([]));
  expect("no tail items means not measured, not a pass", empty.measured === false && empty.g4.freePass === false);

  // `wrangler tail --format json` は整形された複数行 JSON を出す（実測で踏んだ）。
  const pretty = JSON.stringify({ outcome: "ok", entrypoint: "RunWorkflow", cpuTime: 2.5, wallTime: 400 }, null, 4);
  expect("parses pretty-printed tail output", judge(summarizeLines([pretty])).g4.worstMs === 2.5);
  const two = [
    JSON.stringify({ outcome: "ok", entrypoint: "RunWorkflow", cpuTime: 1, wallTime: 10 }, null, 2),
    JSON.stringify({ outcome: "ok", durableObjectId: "x", cpuTime: 2, wallTime: 20 }, null, 2),
  ].join("\n");
  const parsed = summarizeLines([two]);
  expect("parses several pretty-printed objects", parsed.total === 2 && parsed.doInvocations === 1, `total=${parsed.total} do=${parsed.doInvocations}`);

  // 接続を保持する形（長い wall の DO 呼び出し）は event-driven と判定しない。
  const held = judge(summarizeLines([JSON.stringify({ outcome: "ok", durableObjectId: "x", cpuTime: 0.5, wallTime: 20_000 })]));
  expect("a 20s DO call is not event-driven", held.g6.looksEventDriven === false, `wall=${held.g6.doMaxWallMs}`);

  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nselftest passed");
  return failures.length ? 1 : 0;
}

if (args.includes("--selftest")) process.exit(selftest());

const base = option("url", null);
const worker = option("worker", "revise-and-resubmit");
const fixture = option("run", "note-01");
const pace = option("pace", "200");
const idleSeconds = Math.max(0, Number(option("idle", "0")));
if (!base) {
  console.log("NOT RUN  --url https://<worker>.workers.dev を渡してください（デプロイ後に実行します）");
  process.exit(2);
}

const tail = spawn(WRANGLER, ["tail", worker, "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
// `--format json` は整形された複数行 JSON を連結して出す。生のまま貯めて塊で読む。
let tailText = "";
let stderr = "";
tail.stdout.on("data", (chunk) => {
  tailText += String(chunk);
});
tail.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

await new Promise((resolve) => setTimeout(resolve, 6000));

// `--synthetic N` は測定用の自前原稿を作る。step 数が少ない Run では
// invocation の CPU がほぼ per-step の CPU になるので、Free の 10ms を直接読める。
const synthetic = option("synthetic", null);
let manuscript;
let entries;
if (synthetic !== null) {
  const count = Math.min(48, Math.max(1, Number(synthetic)));
  manuscript = Array.from(
    { length: count },
    (_, index) => `段落${index + 1}の見出し\n\nこれは測定用の段落${index + 1}です。読者はここで立ち止まり、理解を書き残します。`,
  ).join("\n\n");
  entries = [];
} else {
  const archive = new URL(`../../../.revise-and-resubmit/${fixture}/`, import.meta.url);
  manuscript = readFileSync(new URL("source.md", archive), "utf8");
  entries = readFileSync(new URL("mind-tail/log.jsonl", archive), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).entry);
}

const started = Date.now();
const created = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ manuscript, lang: "ja", paceMs: Number(pace), mockEntries: entries, manifest: { probe: "probe-deployed", fixture } }),
}).then((response) => response.json());
if (!created.token) {
  tail.kill("SIGTERM");
  console.error("failed to create a run:", created);
  process.exit(1);
}

const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/runs/${created.token}/ws`);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let status = "queued";
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.status) status = message.status;
});
for (let i = 0; i < 300; i++) {
  if (status === "complete" || status === "stopped") break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const elapsed = Date.now() - started;

// 接続を保持したまま何も起こさない区間を作る。ここで DO が dispatch されなければ、
// 接続はオブジェクトを起こし続けていない（＝SSE との差が出る）。
let idleWindow = null;
if (idleSeconds > 0) {
  console.log(`run 完了。接続を保持したまま ${idleSeconds}s 待つ…`);
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
  idleWindow = { start, end: Date.now() };
}
socket.close();
await new Promise((resolve) => setTimeout(resolve, 3000));
tail.kill("SIGTERM");

const summary = summarizeLines([tailText]);
const verdict = judge(summary, { idleWindow });
console.log(`run ${created.token}: ${created.chunks} chunks, status=${status}, ${elapsed}ms\n`);
report(summary, verdict);

mkdirSync(".cache", { recursive: true });
writeFileSync(".cache/g4-report.json", JSON.stringify({ url: base, token: created.token, chunks: created.chunks, elapsedMs: elapsed, idleSeconds, summary, verdict }, null, 2));
console.log("\nwrote .cache/g4-report.json");
if (stderr.trim()) console.log(`\nwrangler tail stderr:\n${stderr.trim().slice(0, 800)}`);
process.exit(verdict.measured && verdict.g4.paidPass ? 0 : 1);
