#!/usr/bin/env node
/**
 * 鍵なしで読者パスを検証するための偽 Messages API。
 *
 *   node tools/fake-anthropic.mjs [--port 9999] [--log .cache/fake-anthropic.jsonl]
 *
 * - `POST /v1/messages` に、Anthropic と同じ形の応答を返す（`stop_reason` を含む）。
 * - 受け取った system / user を JSONL に全部残す（未提示の本文が混ざっていないかを
 *   後から機械的に検査するため）。
 * - `POST /control/refuse` {"count": 1} で、次の N 回を `stop_reason: "refusal"` にできる。
 * - `--delay <ms>` で応答を遅らせる。読者が呼ばれている最中にランタイムを落とす
 *   試験（tools/verify-stall-watchdog.mjs）で、step を確実に in-flight にするため。
 * - 応答本文は、渡された断片から引用を作って返す（結果ページの引用検証を通すため）。
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(option("port", "9999"));
const logPath = option("log", ".cache/fake-anthropic.jsonl");
mkdirSync(dirname(logPath), { recursive: true });

let refusalsLeft = Number(option("refuse-first", "0"));
const delayMs = Number(option("delay", "0"));
const seen = { requests: 0, beta: 0, cacheControl: 0, refusals: 0 };

/** user メッセージから今回の断片だけを取り出す。 */
function extractChunk(user) {
  const match = user.match(/今回の断片（[^）]*）:\n([\s\S]*)$/);
  return match ? match[1].trim() : "";
}

/** 断片から短い引用を作る（本文に実在する文字列だけを使う）。 */
function quoteFrom(chunk) {
  const sentence = chunk.split(/(?<=[。！？])/).find((value) => value.trim().length >= 8) ?? chunk.slice(0, 30);
  return sentence.trim().slice(0, 60);
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => resolve(raw));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/control/refuse" && request.method === "POST") {
    const body = JSON.parse((await readBody(request)) || "{}");
    refusalsLeft = Number(body.count ?? 0);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, refusalsLeft }));
    return;
  }

  if (url.pathname === "/control/reset" && request.method === "POST") {
    seen.requests = 0;
    seen.beta = 0;
    seen.cacheControl = 0;
    seen.refusals = 0;
    refusalsLeft = 0;
    writeFileSync(logPath, "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/control/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...seen, refusalsLeft }));
    return;
  }

  if (url.pathname !== "/v1/messages") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // 遅らせるのは /v1/messages だけ。control/* は試験の手元操作なので即答する。
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

  const raw = await readBody(request);
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid json" }));
    return;
  }

  const systemText = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((block) => block.text ?? "").join("")
      : String(body.system ?? "");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = String(messages.at(-1)?.content ?? "");
  const allText = messages.map((message) => String(message.content ?? "")).join("\n");
  const prefixChars = messages.slice(0, -1).reduce((total, message) => total + String(message.content ?? "").length, 0);
  const chunk = extractChunk(lastUser);
  const index = Number((lastUser.match(/CHUNK (\d+)\//) ?? [])[1] ?? 1);
  const hasCacheControl =
    Boolean(body.cache_control) || (Array.isArray(body.system) && body.system.some((block) => block.cache_control));

  seen.requests += 1;
  if (request.headers["anthropic-beta"]) seen.beta += 1;
  if (hasCacheControl) seen.cacheControl += 1;

  appendFileSync(
    logPath,
    JSON.stringify({
      at: new Date().toISOString(),
      model: body.model,
      beta: request.headers["anthropic-beta"] ?? null,
      maxTokens: body.max_tokens,
      fallbacks: body.fallbacks ?? null,
      systemChars: systemText.length,
      userChars: lastUser.length,
      prefixChars,
      roles: messages.map((message) => message.role),
      hasCacheControl,
      chunkIndex: index,
      chunk,
      system: systemText,
      allText,
      lastUser,
    }) + "\n",
  );

  if (refusalsLeft > 0) {
    refusalsLeft -= 1;
    seen.refusals += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "msg_fake_refusal",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "fake-category" },
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    );
    return;
  }

  const quote = quoteFrom(chunk);
  const note = {
    understanding: `第${index}断片を読んだ。書き手が道具の使い方を説明していると理解した。`,
    evidence: quote ? `「${quote}」という記述。` : "引用できる文が短い。",
    connection: index === 1 ? "見出しの続きとして読んだ。" : "前の断片の話が続いていると読んだ。",
    unresolved: index % 2 === 0 ? "この道具が誰のものかはまだ分からない。" : "なし",
    revision: index === 3 ? "最初は一般的な批判だと思っていたが、自分の道具の説明だと分かった。" : "なし",
    stop: false,
  };

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: `msg_fake_${seen.requests}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify(note) }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: Math.round((systemText.length + lastUser.length) / 3),
        output_tokens: 120,
        cache_creation_input_tokens: seen.requests === 1 ? Math.round(systemText.length / 3) : 0,
        cache_read_input_tokens: seen.requests === 1 ? 0 : Math.round(systemText.length / 3),
      },
    }),
  );
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake anthropic listening on http://127.0.0.1:${port} (log: ${logPath})`);
  if (refusalsLeft) console.log(`refusing the first ${refusalsLeft} request(s)`);
});
