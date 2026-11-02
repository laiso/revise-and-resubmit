/**
 * Workers AI（binding 経由）で読者を動かす。Anthropic の Gateway とは別経路で、
 * プロバイダの鍵も Gateway の残高も要らない。代わりに **プロンプトキャッシュは無い**
 * （Anthropic の `cache_control` に相当する仕組みが無いため、累積入力がそのまま効く）。
 *
 * 使ったモデルは entry ごとに記録する。読者の質はモデルに直結するので、比較の条件が
 * 変わることを後から辿れるようにしておく。
 */
import type { ReaderMessage } from "@revise-and-resubmit/core";

import { ReaderConfigError } from "./reader-errors.ts";

export interface WorkersAiRequest {
  model: string;
  system: string;
  messages: ReaderMessage[];
  maxTokens: number;
}

export interface WorkersAiReply {
  text: string;
  model: string;
  stopReason: string;
  /** Workers AI には分類器の refusal が無いが、呼び出し側と形を揃えておく。 */
  refusalCategory?: string;
  usage: Record<string, unknown> | null;
}

/** モデルごとに違う返り値の形を1つに寄せる。 */
function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    if (typeof value.response === "string") return value.response;
    if (typeof value.text === "string") return value.text;
    const choices = value.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const content = choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  }
  return "";
}

/** `{prompt_tokens, completion_tokens}` を Anthropic 側と同じ名前に寄せる。 */
function normalizeUsage(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== "object") return null;
  const value = usage as Record<string, unknown>;
  return {
    input_tokens: Number(value.prompt_tokens ?? value.input_tokens ?? 0),
    output_tokens: Number(value.completion_tokens ?? value.output_tokens ?? 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    provider: "workers-ai",
    raw: value,
  };
}

function finishReason(result: unknown): string {
  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    const reason = value.finish_reason ?? value.finishReason ?? value.stop_reason;
    if (typeof reason === "string") return reason;
  }
  return "end_turn";
}

export async function callWorkersAi(ai: Ai | undefined, request: WorkersAiRequest): Promise<WorkersAiReply> {
  if (!ai) throw new ReaderConfigError("Workers AI の binding（env.AI）がありません");
  // binding の型はモデル名ごとの総称なので、モデル名を差し替えられるよう緩く呼ぶ。
  const runner = ai as unknown as { run: (model: string, inputs: unknown) => Promise<unknown> };
  let result: unknown;
  try {
    result = await runner.run(request.model, {
      messages: [{ role: "system", content: request.system }, ...request.messages],
      max_tokens: request.maxTokens,
      temperature: 0.2,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 何度やっても同じ種類の失敗は、リトライせず理由を残して止める。
    if (
      /not available on the Workers Free plan|deprecat|no longer (available|supported)|retired|sunset|no such model|model not found|not found|invalid model|unauthor|forbidden|quota|neuron/i.test(
        message,
      )
    ) {
      const code = message.match(/\b(\d{4})\b/)?.[1];
      const plan = /Workers Free plan/i.test(message) ? "（Free プランでは使えません）" : "";
      const deprecated = /deprecat|no longer (available|supported)|retired|sunset/i.test(message) ? "（非推奨）" : "";
      throw new ReaderConfigError(`Workers AI がモデル ${request.model} を使えません${plan}${deprecated}${code ? ` [${code}]` : ""}`);
    }
    throw error;
  }

  return {
    text: extractText(result),
    model: request.model,
    stopReason: finishReason(result),
    usage: normalizeUsage((result as { usage?: unknown } | null)?.usage),
  };
}
