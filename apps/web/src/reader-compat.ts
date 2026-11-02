/**
 * AI Gateway の統一形（OpenAI 互換）で読者モデルを呼ぶ。
 * `provider/model` の文字列1つで Anthropic / Google / OpenAI を切り替えられる。
 *
 * 認証は `cf-aig-authorization` だけ（Unified Billing。プロバイダの鍵は要らない）。
 *
 * 統一形でもプロバイダの差は残る:
 * - OpenAI の新しいモデルは `max_tokens` を受け付けず `max_completion_tokens`。
 * - `anthropic-beta` と `fallbacks`（拒否時の保険）はここでは渡せない。保険が要る
 *   経路は Anthropic 直の `reader-client.ts` を使うこと。
 */
import { ReaderConfigError } from "./reader-errors.ts";
import type { ReaderReply } from "./reader-client.ts";

export interface CompatConfig {
  /** 例: https://gateway.ai.cloudflare.com/v1/{account}/{gateway} */
  baseUrl: string;
  /** 例: google-ai-studio/gemini-3.8-flash */
  model: string;
  aigToken: string;
  maxTokens?: number;
}

/** 3役を立て続けに叩くと Gateway が 429 を返す。少し待って引き直す。 */
const RETRY_DELAYS_MS = [1_500, 4_000, 9_000];

export async function callCompat(
  config: CompatConfig,
  prompt: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> },
): Promise<ReaderReply> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callCompatOnce(config, prompt);
    } catch (error) {
      const rateLimited = error instanceof Error && /\b429\b|Rate limited/i.test(error.message);
      if (!rateLimited || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function callCompatOnce(
  config: CompatConfig,
  prompt: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> },
): Promise<ReaderReply> {
  const budgetKey = config.model.startsWith("openai/") ? "max_completion_tokens" : "max_tokens";
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/compat/chat/completions`, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${config.aigToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      [budgetKey]: config.maxTokens ?? 4096,
      messages: [{ role: "system", content: prompt.system }, ...prompt.messages],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    // モデル名の誤りや権限の不足はリトライしても直らない。理由を残して止める。
    if (response.status === 429) throw new Error(`compat call failed: 429 ${body.slice(0, 160)}`);
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ReaderConfigError(`統一形の呼び出しが ${response.status}: ${body.slice(0, 200)}`);
    }
    throw new Error(`compat call failed: ${response.status} ${body.slice(0, 300)}`);
  }

  let parsed: {
    model?: string;
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    usage?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`compat returned non-json: ${body.slice(0, 300)}`);
  }

  const choice = parsed.choices?.[0];
  return {
    text: (choice?.message?.content ?? "").trim(),
    model: String(parsed.model ?? config.model),
    // 統一形は refusal を別立てにしない。length は max_tokens 相当として扱う。
    stopReason: choice?.finish_reason === "length" ? "max_tokens" : String(choice?.finish_reason ?? ""),
    usage: parsed.usage ?? {},
  };
}
