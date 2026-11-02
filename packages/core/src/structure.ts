/**
 * paper-plot（俯瞰型）。逐次読みではなく、**読者記録が確定してから**全体を見る役。
 *
 * `skills/revise-and-resubmit/references/structure-review.md` の観点を、
 * Web版の1呼び出しに収まる形にしたもの。図（Mermaid / structure.md）は出さない。
 * 指摘だけを、本文の引用に紐づけて返させる。
 *
 * 守ること:
 * - 本文を書き換えない。差し替え文を出さない。
 * - 読者が最後まで読んだことを、構造上の懸念を退ける根拠にしない。逆も同じ。
 * - 必須の型（導入がない、結論が後ろ等）を欠点として宣言しない。
 *   不足している具体的な関係や前提を挙げる。
 * - 引用は本文にある文字列をそのまま返す（表示の錨になる）。
 */

export interface StructureNote {
  quote: string;
  comment: string;
  /**
   * 打ち手。**代替文ではない。** 「この一文をこう直す」は書かせない（著者の文章を
   * 代わりに書くことになる）。編集者が実際にやっているのは、選択肢を名指しして
   * 判断を著者に残すこと。ここはその1〜2個だけ。
   */
  options?: string[];
}

export const PAPER_PLOT_PERSONA = [
  "あなたは paper-plot。議論全体を捉えた人の落ち着きで話す、明晰で分析的なレビュアーです。",
  "自信のある態度は性格であって、全知を意味しません。本文の証拠、自分の推論、分からない意図を区別し続けます。",
  "賢く見せるための用語、著者の動機の捏造、渡されていない資料を理解したという主張は使いません。",
].join("\n");

export function buildStructureSystem(persona = PAPER_PLOT_PERSONA): string {
  return [
    persona,
    "",
    "原稿の全文と、ひとりの読者が少しずつ読みながら残した記録を渡します。",
    "段落の役割とつながりを踏まえて、構造上の懸念だけを挙げてください。",
    "",
    "見るところ:",
    "- 冒頭で予告したことが、どこで回収されたか。回収されていないもの。",
    "- 前提の順序。状況・主体・問いが、それを前提とする詳細より後に出ていないか。",
    "- 例や対比が、何と何を比べているのか本文から分かるか。",
    "- 冒頭の言明と結論が食い違っていないか。",
    "",
    "しないこと:",
    "- 本文の書き換えや差し替え文の提示。",
    "- 「導入がない」「結論が後ろ」といった型の指摘。不足している具体的な関係や前提を挙げる。",
    "- 著者の意図の推測。読者が完読したことを、構造上の懸念を退ける根拠にしない。",
    "",
    "次のJSONだけを返してください。前後に説明やコードフェンスを付けないこと。",
    '{"notes":[{"quote":"本文からそのまま抜いた短い一節","comment":"その箇所についての指摘","options":["打ち手1","打ち手2"]}]}',
    "- quote: **本文に実在する文字列をそのまま**。要約や言い換えにしない。20〜40字程度。",
    "- comment: 2〜3文。どの関係や前提が不足しているか、読者の記録に現れていたかを含める。",
    "- options: 打ち手を1〜2個。**書き換えた文そのものは絶対に書かない。**",
    "  どこに何を足す／削る／動かすか、という選択肢の名指しに留める。",
    "  例：「予告をやめる」「回収を結論より前に置く」。どちらが良いとは言わない。",
    "  打ち手が思いつかなければ options を空の配列にする。無理に出さない。",
    "- 懸念が無ければ notes を空の配列にしてよい。無理に挙げない。",
  ].join("\n");
}

export function buildStructureUserText(source: string, readingLog: string): string {
  return [
    "# 原稿",
    source,
    "",
    "# 読者（mind-tail）の記録",
    readingLog,
  ].join("\n");
}

/** 返答から指摘を取り出す。引用が本文に無いものは、錨にならないので捨てる。 */
export function parseStructureNotes(reply: string, source: string): StructureNote[] {
  const text = reply.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const at = text.indexOf("{");
    const to = text.lastIndexOf("}");
    if (at < 0 || to <= at) return [];
    try {
      parsed = JSON.parse(text.slice(at, to + 1));
    } catch {
      return [];
    }
  }
  const notes = (parsed as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return [];
  return notes
    .map((note) => {
      const raw = note as StructureNote;
      const options = Array.isArray(raw.options)
        ? raw.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 2)
        : [];
      return {
        quote: String(raw.quote ?? "").trim(),
        comment: String(raw.comment ?? "").trim(),
        options,
      };
    })
    .filter((note) => note.comment && note.quote && source.includes(note.quote));
}
