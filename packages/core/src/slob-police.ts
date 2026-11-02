/**
 * slob-police：一度の不満で読むのをやめる読者（逐次型）。
 *
 * `skills/revise-and-resubmit/references/slob-police.md` の規則を、
 * Web版の1区切り1呼び出しに収めたもの。mind-tail とは独立に読ませる。
 *
 * 守ること:
 * - **一度の不満で止まる。** 例を溜めない。回復を期待して読み進めない。
 * - 明快な文章なら、怒りを作り出さず通過してよい。不満を捏造しない。
 * - 怒りは文言と読む負担に向ける。著者の価値・知性・動機に向けない。
 * - 画面に出す発言は短い不満と理由で1〜2文。常体。引用は別欄に置く。
 */

export const SLOB_POLICE_PERSONA = [
  "あなたは slob-police。短気で、とげとげしく、過剰反応しやすい日本語の読者です。",
  "小さな空疎な反復や不自然な表現でも、即座に強い異議を覚えます。外交的な編集者に丸まらないこと。",
  "発言は常体（だ・である）で書きます。です・ます調は使いません。",
  "ただし明快な文章には怒りません。慣用的な用語だけでは違反になりません。",
].join("\n");

/** 止まる理由の分類。`slob-police.md` の3つ。 */
export type SlobCategory = "translationese" | "register" | "padding";

export interface SlobNote {
  index: number;
  /** その区切りで最初に許容できなかった箇所（原文のまま）。通過したときは空。 */
  quote: string;
  /** 画面に出す短い不満と理由。1〜2文、常体。 */
  complaint: string;
  category: SlobCategory | "";
  stop: boolean;
  structured: boolean;
}

export function buildSlobSystem(persona = SLOB_POLICE_PERSONA): string {
  return [
    persona,
    "",
    "原稿を少しずつ渡します。渡された分だけで判断してください。先の本文はありません。",
    "次の3つのどれかで、**初めて**許容できない表現に出会った時点で読むのをやめます。",
    "- 翻訳調：不自然な慣用表現、語順、語の組み合わせ。頭の中で訳し直させるもの。",
    "- 文体の不釣り合い：読者や場面に見合わない学術的・大げさな語彙。技術的な正確さは欠点ではない。",
    "- 内容が薄く雑音の多い文章：紋切り型、空疎な前置き、言い換えの反復、長さの割に内容が増えない要約。",
    "",
    "例を溜めないこと。回復を期待して読み進めないこと。一度で止まります。",
    "明快な文章なら怒らずに通してください。不満を作り出さないこと。",
    "",
    "次のJSONだけを返してください。前後に説明やコードフェンスを付けないこと。",
    '{"quote":"","complaint":"","category":"","stop":false}',
    "- 通過するとき: stop を false にし、他は空でよい。",
    "- 止まるとき: stop を true にし、quote に**本文からそのまま抜いた**許容できない箇所を入れる。",
    "- complaint: 短い不満と理由を1〜2文、常体で。長い講評にしない。",
    "- category: translationese / register / padding のどれか。",
  ].join("\n");
}

export function parseSlobNote(reply: string, index: number): SlobNote {
  const text = reply.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const empty: SlobNote = { index, quote: "", complaint: "", category: "", stop: false, structured: false };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const at = text.indexOf("{");
    const to = text.lastIndexOf("}");
    if (at < 0 || to <= at) return { ...empty, complaint: text.slice(0, 200) };
    try {
      parsed = JSON.parse(text.slice(at, to + 1)) as Record<string, unknown>;
    } catch {
      return { ...empty, complaint: text.slice(0, 200) };
    }
  }
  const category = String(parsed.category ?? "");
  return {
    index,
    quote: String(parsed.quote ?? "").trim(),
    complaint: String(parsed.complaint ?? "").trim(),
    category: (["translationese", "register", "padding"].includes(category) ? category : "") as SlobCategory | "",
    stop: parsed.stop === true,
    structured: true,
  };
}

/** 保存する1行。通過は記録に残すが、画面には出さない。 */
export function formatSlobNote(note: SlobNote): string {
  if (!note.stop) return "（通過）";
  return [note.complaint, note.quote ? `引用：${note.quote}` : "", note.category ? `分類：${note.category}` : ""]
    .filter(Boolean)
    .join("\n");
}
