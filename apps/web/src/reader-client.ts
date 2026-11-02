/**
 * Gateway 経由で読者モデルを呼ぶ。`feed.py` の読者HTTPサーバーに代わる部分。
 *
 * 守ること:
 * - **`content` を読む前に `stop_reason` を見る。** refusal は HTTP 200 で返る。
 * - `betas: [...]` は SDK の糖衣なので、生の fetch では `anthropic-beta` ヘッダで送る。
 * - 固定前置きに `cache_control` を置く（会話が伸びる方向に効かせる）。
 */

import { ReaderConfigError } from "./reader-errors.ts";

export interface ReaderConfig {
  /** Gateway の base URL（例: https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/anthropic）。 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  aigToken?: string;
  /** 例: server-side-fallback-2026-07-01 */
  beta?: string;
  maxTokens?: number;
}

export interface ReaderReply {
  text: string;
  model: string;
  stopReason: string;
  refusalCategory?: string;
  usage: Record<string, unknown>;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string;
  stop_details?: { category?: string };
  content?: AnthropicContentBlock[];
  usage?: Record<string, unknown>;
}

export async function callReader(
  config: ReaderConfig,
  prompt: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> },
): Promise<ReaderReply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  if (config.aigToken) headers["cf-aig-authorization"] = `Bearer ${config.aigToken}`;
  if (config.beta) headers["anthropic-beta"] = config.beta;

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      // Sonnet 5 は thinking トークンも max_tokens を食う。JSON が切れないよう余裕を取る。
      max_tokens: config.maxTokens ?? 4096,
      // 自動キャッシュ: 会話が伸びる方向にブレークポイントを Anthropic 側が動かす。
      // こちらで固定前置きだけを指定するより、交互ターンの全体が再利用される。
      cache_control: { type: "ephemeral" },
      system: prompt.system,
      messages: prompt.messages,
      // `fallbacks` は beta ヘッダとセットでしか受け付けられない。ヘッダ無しで
      // 送ると 400「fallbacks: Extra inputs are not permitted」が即返る
      // （Gateway ログの 319ms / 978ms / 1595ms の3件がこれだった）。
      ...(config.beta ? { fallbacks: "default" } : {}),
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    // 401/402/403 は何度やっても同じ。リトライせず、理由を残して止める。
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      let reason = body.slice(0, 160);
      try {
        const parsed = JSON.parse(body) as { error?: Array<{ message?: string }>; message?: string };
        reason = parsed.error?.[0]?.message ?? parsed.message ?? reason;
      } catch {
        // 素のテキストのまま使う
      }
      throw new ReaderConfigError(`Gateway が拒否しました（${response.status}）: ${reason}`);
    }
    throw new Error(`reader call failed: ${response.status} ${body.slice(0, 300)}`);
  }

  let parsed: AnthropicResponse;
  try {
    parsed = JSON.parse(body) as AnthropicResponse;
  } catch {
    throw new Error(`reader returned non-json: ${body.slice(0, 300)}`);
  }

  // refusal は HTTP 200 のまま返る。content より先に stop_reason を見る。
  const stopReason = String(parsed.stop_reason ?? "");
  if (stopReason === "refusal") {
    return {
      text: "",
      model: String(parsed.model ?? config.model),
      stopReason,
      refusalCategory: parsed.stop_details?.category,
      usage: parsed.usage ?? {},
    };
  }

  const text = (parsed.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();

  return {
    text,
    model: String(parsed.model ?? config.model),
    stopReason,
    usage: parsed.usage ?? {},
  };
}
