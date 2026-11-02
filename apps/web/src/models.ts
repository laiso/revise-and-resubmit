/**
 * 使ってよいモデルの一覧。**ここに無いものは断る。**
 *
 * 禁止リストにすると、知らないモデルが既定値や設定漏れで通ってしまう。実際に
 * gateway 経路の既定値が `claude-sonnet-5` のまま残り、`COMPAT_BASE_URL` を渡し
 * 忘れて起動した実行が、そうと分からないまま3モデル中いちばん高いもので走っていた。
 * 高いモデルを**意図して**選ぶのは構わない。意図せず選ばれるのを止めたい。
 *
 * 費用は 2026-09-22 の実測（zenn-01、21断片）。空欄は未測定。
 */

export interface AllowedModel {
  /** 入稿とログに出る名前。compat は `provider/model`、Workers AI は `@cf/…`。 */
  id: string;
  /** 1 Run の実費の目安（21断片で測った値）。未測定なら空。 */
  cost?: string;
  note: string;
}

/** 読者（逐次読み）に使ってよいモデル。 */
export const READER_MODELS: AllowedModel[] = [
  {
    id: "google-ai-studio/gemini-3.8-flash",
    cost: "$0.11",
    note: "既定。3モデルの比較で最も速く最も安く、真の修正率は落ちなかった。",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    cost: "$0.22",
    note: "比較対象。Gemini の2倍の実費で、質の差は見えなかった。",
  },
  {
    // gateway 経路（native /v1/messages）はこの綴りしか受け取らない。
    // 実体は上の anthropic/claude-haiku-4.5 と同じモデル。
    id: "claude-haiku-4-5-20251001",
    cost: "$0.22",
    note: "gateway 経路用。compat の anthropic/claude-haiku-4.5 と同じもの。",
  },
  {
    id: "openai/gpt-5.6-luna",
    cost: "$0.013（10断片）",
    note: "比較対象。安いが修正の申告が多く、真の修正率は 10%。",
  },
  // Anthropic を Gateway の /v1/messages 経由で呼ぶ経路（`reader-client.ts`）。
  // ここに名前が1つも無い間、この経路は入稿の時点で必ず断られていた。
  // 122行が実行されない状態で、`plan.md:241` の「常用は Gateway 経由」とも
  // 食い違っていた。プロンプトキャッシュを送っているのはこの経路だけなので、
  // 消すのではなく、安いほうだけを一覧に載せる。
  // `claude-sonnet-5` は載せない。既定値のまま走って3モデル中いちばん高いもので
  // 実行された事故が、この一覧を作った理由そのものだから。
  {
    id: "claude-haiku-4-5-20251001",
    cost: "$0.22",
    note: "Gateway 経由。プロンプトキャッシュが効く唯一の経路（0002 で実測）。",
  },
  // ローカルの偽サーバー（`tools/fake-anthropic.mjs`）だけが応答する名前。
  // 一覧に無いと、課金なしの検証構成が入稿の時点で 400 になって起動しない。
  // 実在しないモデル名なので、本番の提供元に送っても通らない。
  { id: "fake-reader-1", note: "検証用。ローカルの偽サーバー専用。" },
  { id: "fake-reader-fallback", note: "検証用。拒否されたときの差し替え先。" },
  // Workers AI。Free プランで動くことを実機で確かめたものだけ。
  { id: "@cf/openai/gpt-oss-20b", note: "Workers AI の既定。Free で動く。" },
  { id: "@cf/qwen/qwen3.8-27b", note: "Free で完走を確認（実測19.2分と遅い）。" },
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", note: "Free で動く。" },
];

/**
 * 下調べ（決定記録 0003）に使ってよいモデル。読者とは別枠。
 * 検索ツールが要るので、いまのところ Anthropic 経由しか選べない
 * （Google AI Studio の grounding は同じ Gateway で 429 を返す）。
 */
export const PRESEARCH_MODELS: AllowedModel[] = [
  { id: "claude-haiku-4-5-20251001", note: "既定。検索して一行にするだけなので小さいもので足りる。" },
];

const READER_IDS = new Set(READER_MODELS.map((model) => model.id));
const PRESEARCH_IDS = new Set(PRESEARCH_MODELS.map((model) => model.id));

/**
 * ID の綴りから、その名前が通じる経路を決める。
 * `@cf/…` は Workers AI、`provider/model` は統一形（compat）、それ以外は
 * Anthropic 直の `/v1/messages`（gateway）。
 */
export type Route = "workers-ai" | "compat" | "gateway";

export function routeOf(id: string): Route {
  if (id.startsWith("@cf/")) return "workers-ai";
  return id.includes("/") ? "compat" : "gateway";
}

/**
 * 一覧に無ければ理由を返す。あれば null。
 *
 * `route` を渡すと、綴りがその経路のものかも見る。一覧に載っていることと、
 * **いまの経路で通じること**は別。gateway 経路に `google-ai-studio/gemini-3.8-flash`
 * を設定すると、一覧は通るが native の `/v1/messages` が受け取らず、読書が
 * 1断片目で死ぬ。入稿前に断れなければ、直したはずの失敗が後ろへずれるだけになる。
 */
export function refuseModel(
  id: string,
  kind: "reader" | "presearch" = "reader",
  route?: Route,
): string | null {
  const allowed = kind === "presearch" ? PRESEARCH_IDS : READER_IDS;
  if (!allowed.has(id)) {
    return `このモデルは使えません: ${id}。使えるのは ${[...allowed].join(" / ")} です。`;
  }
  if (route && routeOf(id) !== route) {
    const usable = [...allowed].filter((candidate) => routeOf(candidate) === route);
    return usable.length
      ? `このモデルは ${route} 経路では使えません: ${id}。${route} で使えるのは ${usable.join(" / ")} です。`
      : `このモデルは ${route} 経路では使えません: ${id}。${route} で使えるモデルは一覧にありません。`;
  }
  return null;
}
