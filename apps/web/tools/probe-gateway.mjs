#!/usr/bin/env node
/**
 * G1 の実測: AI Gateway 経由で Anthropic の Messages API を叩き、次を確かめる。
 *
 *   1. `anthropic-beta: server-side-fallback-2026-07-01` が通るか（400 にならない）
 *   2. `fallbacks: "default"` が受け付けられるか
 *   3. `stop_reason` が content を読む前に見られるか（refusal の検出）
 *   4. `usage.cache_creation_input_tokens` / `cache_read_input_tokens` が観測できるか
 *   5. `response.model` が返るか（フォールバックでモデルが差し替わったことに気づけるか）
 *
 * 鍵が無い環境では「未実行」として終了コード 2 を返す（失敗と区別する）。
 *
 *   CF_ACCOUNT_ID=... CF_GATEWAY_ID=... ANTHROPIC_API_KEY=... node tools/probe-gateway.mjs
 *   CF_ACCOUNT_ID=... CF_GATEWAY_ID=... CF_AIG_TOKEN=...  node tools/probe-gateway.mjs   # BYOK の場合
 *
 * 注意: プロンプトキャッシュは最小トークン数（Sonnet 系で 1024）に満たないと効かない。
 * このプローブは固定前置きを意図的に長くして、キャッシュの観測を成立させる。
 */
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const account = process.env.CF_ACCOUNT_ID;
const gateway = process.env.CF_GATEWAY_ID;
const apiKey = process.env.ANTHROPIC_API_KEY;
const aigToken = process.env.CF_AIG_TOKEN;
const model = option("model", "claude-sonnet-5");
const useThinking = args.includes("--thinking");

const missing = [];
if (!account) missing.push("CF_ACCOUNT_ID");
if (!gateway) missing.push("CF_GATEWAY_ID");
if (!apiKey && !aigToken) missing.push("ANTHROPIC_API_KEY（または BYOK の CF_AIG_TOKEN）");
if (missing.length) {
  console.log("NOT RUN  G1 の実測には次が必要です: " + missing.join(", "));
console.log("         CF_GATEWAY_ID は既定で `default` を試します。");
  console.log("         鍵が用意できたらこのコマンドを再実行してください。");
  process.exit(2);
}

const endpoint = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/anthropic/v1/messages`;
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(label);
};

// 固定前置きを長くしてキャッシュの最小トークンを超えさせる。
// **このプローブだけは毎回ユニークな nonce を前置きに混ぜる。** 5分のキャッシュが
// 前回の実行で温まっていると「1回目で作成」を確かめられないため。本番の前置きには
// 実行IDや時刻を混ぜてはいけない（1バイト変わると無効化される）。
const nonce = crypto.randomUUID();
const preamble =
  `probe-nonce:${nonce}\n` +
  Array.from({ length: 90 }, (_, index) =>
    `読者は与えられた断片だけを根拠に、その時点の理解と未解決点を自分の言葉で記録する。断片${index + 1}。`,
  ).join("");

const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
if (apiKey) headers["x-api-key"] = apiKey;
if (aigToken) headers["cf-aig-authorization"] = `Bearer ${aigToken}`;
// 生の fetch では `betas: [...]` は効かない（SDK の糖衣）。ヘッダで送る。
headers["anthropic-beta"] = "server-side-fallback-2026-07-01";

async function call(messages) {
  const body = {
    model,
    max_tokens: 256,
    // 固定前置きにブレークポイントを置き、2回目で読ませる。
    system: [{ type: "text", text: preamble, cache_control: { type: "ephemeral" } }],
    messages,
    fallbacks: "default",
  };
  if (useThinking) body.thinking = { type: "adaptive" };
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // エラー本文が HTML/テキストのこともある
  }
  return { response, parsed, text };
}

const first = await call([{ role: "user", content: "「較正された確率」を一文で説明してください。" }]);
console.log(`HTTP ${first.response.status}  model=${first.parsed?.model ?? "-"}`);
console.log(`Cloudflare: cf-aig-cache-status=${first.response.headers.get("cf-aig-cache-status") ?? "-"} ray=${first.response.headers.get("cf-ray") ?? "-"}`);
if (first.response.status !== 200) {
  console.log(first.text.slice(0, 600));
  // 次に何をすればよいかまで出す。生の status だけでは動けない。
  if (first.response.status === 402) {
    console.log(
      "\n→ AI Gateway が Unified Billing（wholesale credits）で残高不足です。ダッシュボードでクレジットを追加するか、\n" +
        "  BYOK で Anthropic キーを Gateway に保存するか、ANTHROPIC_API_KEY を渡してリクエストに載せてください（x-api-key）。",
    );
  } else if (first.response.status === 401 || first.response.status === 403) {
    console.log("\n→ CF_AIG_TOKEN がこの gateway に対して無効か、CF_GATEWAY_ID が違います。");
  } else if (first.response.status === 404) {
    console.log("\n→ gateway が見つかりません。CF_GATEWAY_ID を確認してください（既定は `default`）。");
  } else if (first.response.status === 400 && /beta/i.test(first.text)) {
    console.log("\n→ anthropic-beta ヘッダが拒否されました。beta 名の綴りと有効期限を確認してください。");
  }
  check("gateway accepts the request with the server-side fallback beta header", false, `status=${first.response.status}`);
} else {
  check("gateway accepts the request with the server-side fallback beta header", true);
  check("fallbacks:\"default\" is accepted", true);
  // refusal は HTTP 200 のまま返るので、content より先に stop_reason を見る。
  check("stop_reason is visible before reading content", typeof first.parsed.stop_reason === "string", `stop_reason=${first.parsed.stop_reason}`);
  check("stop_reason is not a refusal", first.parsed.stop_reason !== "refusal", first.parsed.stop_details?.category ?? "");
  check("response.model is reported", typeof first.parsed.model === "string", first.parsed.model);
  check(
    "usage reports cache_creation_input_tokens",
    Number(first.parsed.usage?.cache_creation_input_tokens) > 0,
    JSON.stringify(first.parsed.usage ?? {}),
  );
}

if (first.response.status === 200) {
  const second = await call([
    { role: "user", content: "「較正された確率」を一文で説明してください。" },
    { role: "assistant", content: first.parsed.content?.[0]?.text ?? "…" },
    { role: "user", content: "では、較正が崩れる例を一つ。" },
  ]);
  console.log(`\n2回目 HTTP ${second.response.status}`);
  if (second.response.status !== 200) {
    console.log(second.text.slice(0, 600));
    check("second call succeeds", false, `status=${second.response.status}`);
  } else {
    const usage = second.parsed.usage ?? {};
    check("second call succeeds", true);
    check("usage reports cache_read_input_tokens", Number(usage.cache_read_input_tokens) > 0, JSON.stringify(usage));
  }
}

console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join(", ")}`
    : "\nG1 は通りました。結果を決定記録と plan.md に反映してください。",
);
process.exit(failures.length ? 1 : 0);
