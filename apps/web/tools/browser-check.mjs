#!/usr/bin/env node
/**
 * 実ブラウザでの確認。ヘッドレスの Chromium を CDP で操り、ライブ画面が
 * 「接続し、積み上がり、未読を出さず、結果ページへ行ける」ことを見る。
 *
 *   node tools/browser-check.mjs [--base http://127.0.0.1:8787] [--run note-01]
 *                               [--token <existing>] [--shot ../../.cache/demo-live.png]
 *
 * 依存パッケージは使わない（Node の WebSocket で CDP を直に話す）。
 * 台本は .revise-and-resubmit/ のアーカイブ（gitignore 済み）を読む。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option("base", "http://127.0.0.1:8787");
const fixture = option("run", "note-01");
const existing = option("token", null);
const shotPath = option("shot", ".cache/demo-live.png");
const port = Number(option("port", "9222"));

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

/** 台本の最後の段落。ライブ画面に出てはいけない文字列として使う。 */
function fixtureSource() {
  try {
    return readFileSync(new URL(`../../../.revise-and-resubmit/${fixture}/source.md`, import.meta.url), "utf8");
  } catch {
    return null;
  }
}

function paragraphs(source) {
  return source.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
}

function lateProbe() {
  const source = fixtureSource();
  if (!source) return null;
  const last = paragraphs(source).at(-1) ?? "";
  return last.length > 40 ? last.slice(0, 40) : last;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result?.value;
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(new Cdp(socket)));
    socket.addEventListener("error", reject);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await wait(250);
  }
  throw new Error("chromium debug port did not open");
}

// 1. 台本を流して Run を作る（--token 指定がなければ）。
let token = existing;
if (!token) {
  const archive = new URL(`../../../.revise-and-resubmit/${fixture}/`, import.meta.url);
  const manuscript = readFileSync(new URL("source.md", archive), "utf8");
  const entries = readFileSync(new URL("mind-tail/log.jsonl", archive), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).entry);
  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manuscript, lang: "ja", paceMs: 1200, mockEntries: entries }),
  }).then((response) => response.json());
  token = created.token;
  check("run created for the browser check", Boolean(token), `${created.chunks} chunks`);
}

const probe = lateProbe();
const chromium = spawn(
  "chromium",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1280,900",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=.cache/chrome-profile",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  await waitForDevtools();
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${base}/r/${token}`)}`, {
    method: "PUT",
  }).then((response) => response.json());
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  // 2. 接続と、最初の1件が届くまで待つ。
  //    実エッジでは最初の1件に数秒かかるので、接続直後に0件でも失敗にしない。
  let ready = false;
  let primed = false;
  for (let i = 0; i < 80; i++) {
    const state = await cdp.eval(`(() => {
      const dot = document.getElementById("dot");
      return {
        hasLog: Boolean(document.getElementById("log")),
        connected: dot ? dot.className.includes("on") : false,
        cards: document.querySelectorAll("#log .card").length,
        status: document.getElementById("status").textContent
      };
    })()`);
    if (state?.hasLog && state.connected) ready = true;
    if (ready && (state.cards >= 1 || state.status === "complete")) {
      primed = true;
      break;
    }
    await wait(250);
  }
  check("browser connects to the live stream", ready);
  check("the first log entry arrives", primed);
  check("websocket badge shows connected", (await cdp.eval('document.getElementById("conn").textContent')) === "接続済み");

  const sample = () =>
    cdp.eval(`(() => {
      const panes = Array.from(document.querySelectorAll(".pane")).map((pane) => {
        const rect = pane.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                 scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
      });
      const current = document.querySelector("#manuscript .chunk.current");
      const currentRect = current ? current.getBoundingClientRect() : null;
      return {
        cards: document.querySelectorAll("#log .card").length,
        chunks: document.querySelectorAll("#manuscript .chunk").length,
        current: current ? current.textContent : "",
        currentTop: currentRect ? currentRect.top : null,
        currentBottom: currentRect ? currentRect.bottom : null,
        panes: panes,
        windowScrollY: window.scrollY,
        title: document.getElementById("title").textContent,
        progress: document.getElementById("progress").textContent,
        status: document.getElementById("status").textContent,
        resultHref: document.getElementById("result").getAttribute("href"),
        changed: document.querySelectorAll("#log .card.changed").length,
        text: document.body.innerText
      };
    })()`);

  const first = await sample();
  check("log cards are rendering", first.cards >= 1, `cards=${first.cards}`);
  check("the served chunk is highlighted", first.current.length > 0, first.current.slice(0, 24));
  check("header shows the manuscript title", first.title !== "原稿", first.title.slice(0, 30));
  check("progress counts served chunks", /\d+\/\d+/.test(first.progress), first.progress);
  check("result link points at the result page", first.resultHref === `/r/${token}/result`, first.resultHref);
  check("ahead-of-reading text is not on the page", probe ? !first.text.includes(probe) : true, probe ? `probe="${probe.slice(0, 18)}…"` : "no fixture probe");
  check("two panes sit side by side", first.panes.length === 2 && first.panes[0].right <= first.panes[1].left + 1);
  check(
    "the manuscript pane keeps the current chunk in view",
    first.currentTop !== null && first.currentTop >= first.panes[0].top - 1 && first.currentBottom <= first.panes[0].bottom + 1,
  );

  await wait(3500);
  const second = await sample();
  check("cards accumulate over time", second.cards > first.cards, `${first.cards} → ${second.cards}`);
  check(
    "the log pane follows on its own",
    second.panes[1].scrollTop > 0 && second.panes[1].scrollHeight > second.panes[1].clientHeight,
    `logScrollTop=${Math.round(second.panes[1].scrollTop)}`,
  );
  check("following the log does not move the manuscript pane", second.windowScrollY === 0, `windowScrollY=${second.windowScrollY}`);
  check("still no ahead-of-reading text", probe ? !second.text.includes(probe) : true);

  // 3. スクリーンショット（見た目の証拠）。
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(shotPath), { recursive: true });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  check("screenshot captured", true, shotPath);

  // 4. 完了を待って、結果ページをブラウザで開く。
  let state = null;
  for (let i = 0; i < 120; i++) {
    state = await fetch(`${base}/api/runs/${token}/state`).then((response) => response.json());
    if (state.status === "complete" || state.status === "stopped") break;
    await wait(500);
  }
  check("run completes", state?.status === "complete", `status=${state?.status}`);

  await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${base}/r/${token}/result`)}`, { method: "PUT" });
  await wait(1200);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const resultTarget = targets.find((entry) => entry.url.endsWith("/result"));
  const resultCdp = await connect(resultTarget.webSocketDebuggerUrl);
  const result = await resultCdp.eval(`(() => ({
    cards: document.querySelectorAll("article.card").length,
    quotes: document.querySelectorAll("blockquote").length,
    changed: document.querySelectorAll("article.card.changed").length,
    quoteLengths: Array.from(document.querySelectorAll("blockquote")).map((node) => node.textContent.length),
    text: document.body.innerText
  }))()`);
  check("result page renders comments", result.cards === state.entries.length, `${result.cards} cards`);
  check("result page renders quotes", result.quotes >= 10, `${result.quotes} quotes`);
  check("result page marks revisions", result.changed >= 3, `${result.changed} revision cards`);
  const longestQuote = Math.max(0, ...result.quoteLengths);
  check("quotes are short excerpts, not body text", longestQuote > 0 && longestQuote < 200, `longest=${longestQuote} chars`);

  // 配信された chunk そのものが結果ページに載っていないこと（引用は短い抜粋だけ）。
  const middleChunk = state.entries[Math.floor(state.entries.length / 2)]?.text ?? "";
  const verbatim = middleChunk.length > 200 ? middleChunk.slice(0, 200) : null;
  check(
    "result page carries no long verbatim run of the served text",
    verbatim ? !result.text.includes(verbatim) : true,
    verbatim ? "200 chars from the middle chunk" : "chunks too short to probe",
  );

  const resultShot = await resultCdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const resultPath = shotPath.replace(/\.png$/, "-result.png");
  writeFileSync(resultPath, Buffer.from(resultShot.data, "base64"));
  check("result screenshot captured", true, resultPath);
  // 5. 長い空白をまたぐ Run で、取りこぼした push を画面が自分で直すこと。
  //    push は best-effort（DO が起き直した直後に落ちるのを実測している）。
  const slowManuscript = [
    "最初の段落です。ここは長い空白の前に読まれます。",
    "二番目の段落です。空白をまたいで届きます。",
    "三番目の段落です。ここも空白をまたぎます。",
  ].join("\n\n");
  const slow = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manuscript: slowManuscript, lang: "ja", paceMs: 5000, reader: "mock" }),
  }).then((response) => response.json());
  const slowTarget = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${base}/r/${slow.token}`)}`, {
    method: "PUT",
  }).then((response) => response.json());
  const slowCdp = await connect(slowTarget.webSocketDebuggerUrl);
  await wait(1500);
  let view = null;
  for (let i = 0; i < 60; i++) {
    view = await slowCdp.eval(`({
      cards: document.querySelectorAll("#log .card").length,
      chunks: document.querySelectorAll("#manuscript .chunk").length,
      status: document.getElementById("status").textContent
    })`);
    if (view.cards === slow.chunks && view.status === "complete") break;
    await wait(1000);
  }
  check(
    "the page converges on every record across idle gaps",
    view.cards === slow.chunks,
    `${view.cards}/${slow.chunks} cards, ${view.chunks} chunks, status=${view.status}`,
  );
} finally {
  chromium.kill("SIGTERM");
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nall browser checks passed");
process.exit(failures.length ? 1 : 0);
