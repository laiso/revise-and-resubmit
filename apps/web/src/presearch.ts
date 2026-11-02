/**
 * 読ませる前の下調べ。**調べるのは進行役で、読者ではない**（決定記録 0003）。
 *
 * 4モデル全部が readme-02 の「GPT-6 Atlas」を未解決として持ち越したが、人間が
 * 妥当性を確認済みのアーカイブは一度も触れていない。あれは原稿の欠陥ではなく、
 * 読者モデルの学習データの切れ目だった。読者に検索させると知識の境界が実行ごとに
 * 動き、公開記事なら先の内容まで見えてしまう。だから調べる主体と時点をここに移す。
 *
 * 結果は「想定読者が既に知っていること」として、読書が始まる前に一度だけ固定する。
 */

import { PRESEARCH_MODELS, refuseModel } from "./models.ts";

export interface PresearchConfig {
  /** https://gateway.ai.cloudflare.com/v1/{account}/{gateway} */
  baseUrl: string;
  aigToken: string;
  model?: string;
}

export interface Term {
  term: string;
  gloss: string;
}

export interface Presearch {
  terms: Term[];
  /** 拾ったが解決しなかった語。0003 が記録を求めている。 */
  unresolved: string[];
  /** 調べられなかった場合の理由。空なら成功。 */
  note: string;
}

/**
 * 検索の経路。AI Gateway 経由の Anthropic の web_search を使う。
 * Google AI Studio の grounding は同じ Gateway で 429（RESOURCE_EXHAUSTED）を返し、
 * 本文生成だけが通る状態だったため採らない。
 * `allowed_callers: ["direct"]` が要る（無いと programmatic tool calling を要求されて 400）。
 */
const SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 5,
  allowed_callers: ["direct"],
};

/** 下調べに使うモデル。一覧の先頭を既定にする（読者とは別枠。models.ts）。 */
const DEFAULT_MODEL = PRESEARCH_MODELS[0].id;

/** 原稿のうち、語を拾うために渡す量。全文を渡す必要はない。 */
const SCAN_CHARS = 6000;

const INSTRUCTION = [
  "次の原稿に出てくる固有名詞（製品名・モデル名・サービス名・機能名・規格名）のうち、",
  "**あなた自身が、自分の知識だけで自信を持って一行で説明できないもの**を拾ってください。",
  "判断に迷ったら拾う側に倒すこと。原稿がその語を説明しているかどうかは関係ありません。",
  "見覚えがあるようで確信が持てない名前、新しそうな名前、どれも対象です。多くても5個。",
  "拾った語は**必ず** web_search で調べ、**一行で**説明してください。",
  "語は**原稿に書かれているとおりの表記**で返すこと（原稿を検索すれば見つかる文字列にする）。",
  "検索しても正体が確認できなかった語は unresolved に入れます。**推測で説明を書かないこと。**",
  "検索の結果その名前が存在しないと分かった場合も、説明をでっち上げず unresolved に入れてください。",
  "最後に、次の JSON だけを出力してください。前後に説明を付けないこと。",
  '{"terms":[{"term":"…","gloss":"…"}],"unresolved":["…"]}',
  "該当が無ければ terms も unresolved も空配列にしてください。",
].join("\n");

export async function presearch(config: PresearchConfig, manuscript: string): Promise<Presearch> {
  const model = config.model ?? DEFAULT_MODEL;
  // 下調べも一覧の外へは出さない。読者だけ縛っても、意図しない支出は止まらない。
  const refused = refuseModel(model, "presearch");
  if (refused) return { terms: [], unresolved: [], note: refused };
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "cf-aig-authorization": `Bearer ${config.aigToken}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        tools: [SEARCH_TOOL],
        messages: [{ role: "user", content: `${INSTRUCTION}\n\n---\n${manuscript.slice(0, SCAN_CHARS)}` }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      return { terms: [], unresolved: [], note: `下調べを呼べませんでした（${response.status}）: ${detail.slice(0, 160)}` };
    }
    const parsed = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (parsed.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    const found = text.match(/\{[\s\S]*\}/);
    if (!found) return { terms: [], unresolved: [], note: "下調べの返答を読めませんでした。" };
    const data = JSON.parse(found[0]) as { terms?: Term[]; unresolved?: string[] };
    const terms = (data.terms ?? [])
      .filter((entry) => entry && typeof entry.term === "string" && typeof entry.gloss === "string")
      // 引用タグ（<cite index=…>）が混じって返る。読者に渡すのは中身の一行だけ。
      .map((entry) => ({ term: entry.term, gloss: entry.gloss.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() }))
      // 原稿に実在する語だけ。無い語を「既知」として渡すと、読者の前提が原稿とずれる。
      .filter((entry) => manuscript.includes(entry.term))
      .slice(0, 5);
    // 確認できなかった語は読者に渡さない。渡すと「知っている前提」が嘘になる。
    // ただし著者には見せる。読者が詰まったのが原稿のせいか読者の無知かは、これで分かれる。
    const unresolved = (data.unresolved ?? []).filter((value) => typeof value === "string").slice(0, 5);
    return { terms, unresolved, note: "" };
  } catch (error) {
    return { terms: [], unresolved: [], note: `下調べに失敗しました: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 読者のシステムに足す「想定読者の既知」。渡すのは結果の一行だけ。 */
export function knowledgeBlock(terms: Term[]): string {
  if (!terms.length) return "";
  return [
    "想定読者が既に知っていること（この読者の前提として扱い、知らないものとして書かないこと）:",
    ...terms.map((entry) => `- ${entry.term}: ${entry.gloss}`),
  ].join("\n");
}
