/**
 * 読者プロンプトの組み立てと、読者の出力の構造化。
 *
 * `feed.py` は読者に `BRIEFING` と `chunk_header` / `chunk_footer` を渡し、ログを
 * 「理解・根拠・接続・未解決・修正」の自由文で受け取っていた。Web 版は同じ手順を
 * 保ったまま、**停止申告と修正の有無を機械的に読める形**で受け取る（決定記録 0002）。
 * 表示用の文面はarchiveと同じ並びに整えてから保存するので、逐次ログの見え方と
 * 引用の抽出自体は変えない。
 */
import type { Lang } from "./chunk.ts";
import { BRIEFING, chunkHeader, count, unit } from "./chunk.ts";

export interface ReaderNote {
  index: number;
  understanding: string;
  evidence: string;
  connection: string;
  unresolved: string;
  revision: string;
  stop: boolean;
  /** 構造化に失敗して自由文のまま記録した場合に false。実験結果として数えない。 */
  structured: boolean;
}

export interface ReaderTurn {
  index: number;
  total: number;
  /** この区切りより後に残っている量（`chunk_header` と同じ数え方）。 */
  remaining: number;
  chunk: string;
  lang: Lang;
}

const FIELDS = ["understanding", "evidence", "connection", "unresolved", "revision"] as const;
const JAPANESE_LABELS: Record<string, (typeof FIELDS)[number]> = {
  理解: "understanding",
  根拠: "evidence",
  接続: "connection",
  未解決: "unresolved",
  修正: "revision",
};

/**
 * 固定前置き（ペルソナ＋読書手順＋出力の指示）。プロンプトキャッシュの
 * ブレークポイントをここに置くので、実行IDや時刻を混ぜてはいけない。
 */
export function buildReaderSystem(persona: string, knowledge = ""): string {
  return [
    persona,
    "",
    // 想定読者の既知。進行役が読ませる前に一度だけ調べた結果で、読者は検索しない
    // （決定記録 0003）。ここに置くのは、読書の履歴ではなく読む前からの前提だから。
    ...(knowledge ? [knowledge, ""] : []),
    BRIEFING,
    "",
    "次の断片だけを読み、指示どおりに記録してください。全文は渡されません。",
    "次のJSONだけを返してください。前後に説明やコードフェンスを付けないこと。",
    '{"understanding":"…","evidence":"…","connection":"…","unresolved":"…","revision":"…","stop":false}',
    // 「書き手が〜している」と書かせない。それは文章についての解説であって、
    // 読者の反応ではない。欲しいのは編集者が余白に書く独り言のほうで、
    // 解説調にすると、どのカードも同じ調子になって読めなくなる。
    "- understanding: **本文が述べている中身**を、自分の言葉で短く。1〜2文。",
    "  「書き手が〜している」「〜が示されている」のような、書き手や文章についての",
    "  解説にしないこと。読みながら頭に浮かんだことを、そのまま書く。",
    "- evidence: 短い引用と、予備知識・推測による補足。本文にある事実と推測を混ぜない。",
    "- connection: 見出しや直前の話とのつながりと、理解に何を加えたか。",
    "- unresolved: まだ分からないことを、思ったままの言い方で短く。無ければ「なし」。",
    "- revision: 以前の理解から変わった点とそのきっかけ。無ければ「なし」。",
    "- 読むのをやめる場合は stop を true にし、理由を unresolved に書く。",
    "- 最後の断片まで読み終えた場合は stop を使わない（残りが無いことは位置の表示で分かる）。",
    // 位置の表示（CHUNK 6/10 など）は進行のための情報であり、読者の記録に出す
    // ものではない。出ると結果ページにそのまま載る（room.md）。
    "- 位置の表示（CHUNK 6/10 など）や断片の番号を、記録の中で引き合いに出さないこと。前の話を指すときは、本文の言葉で言うこと（例:「冒頭の使い方の説明」）。",
  ].join("\n");
}

/** そのターンの user 部分（位置・本文）。 */
export function buildReaderTurnText(input: { index: number; total: number; chunk: string; lang: Lang }): string {
  const header = chunkHeader(input.index, new Array(input.total).fill(""), input.lang);
  const served = `${count(input.chunk, input.lang)} ${unit(input.lang)}`;
  return [`位置: ${header}`, `今回の断片（${served}）:`, input.chunk].join("\n");
}

/** 読者が答えた内容を、こちらが要求したのと同じ形で assistant ターンに戻す。 */
export function noteToAssistantContent(note: Pick<ReaderNote, "understanding" | "evidence" | "connection" | "unresolved" | "revision" | "stop">): string {
  return JSON.stringify({
    understanding: note.understanding,
    evidence: note.evidence,
    connection: note.connection,
    unresolved: note.unresolved,
    revision: note.revision,
    stop: note.stop,
  });
}

export interface ReaderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ReaderTurnInput {
  index: number;
  total: number;
  chunk: string;
  lang: Lang;
  /** その区切りに対する読者自身の記録。最後のターン（今回読む区切り）には無い。 */
  note?: ReaderNote;
}

/**
 * 会話を交互のターンとして組み立てる。過去の区切り（user）と自分の記録（assistant）を
 * 並べるので、**各リクエストの入力が前のリクエストの接頭辞になる**。プロンプトキャッシュは
 * この形で初めて伸びる会話全体に再利用される（過去メモを1つの user に詰める形だと、
 * 固定前置きしか再利用できない）。
 *
 * **この形が得になるのは、経路がキャッシュを使う場合だけ**である。使わない経路では、
 * 入力が断片数の二乗で伸びるぶんをそのまま払う。2026-09-22 の実測（同じ約8,200字の
 * 原稿）:
 *   Gateway 経由（cache_control あり）… 非キャッシュ 56 / 書込 23,231 / 読出 304,547
 *   統一形（cache_control なし）      … 非キャッシュ 167,531（蓄積なしの下限 23,258）
 * 統一形が既定なので、いまの本番は下限の 7.2 倍の入力トークンを払っている。
 * 統一形でキャッシュを効かせられるかは未確認で、実機で1回測れば決まる。
 */
export function buildReaderMessages(inputs: ReaderTurnInput[]): ReaderMessage[] {
  const messages: ReaderMessage[] = [];
  for (const input of inputs) {
    messages.push({ role: "user", content: buildReaderTurnText(input) });
    if (input.note) messages.push({ role: "assistant", content: noteToAssistantContent(input.note) });
  }
  return messages;
}

/** 読者の応答からJSONを取り出す。壊れていても例外にしない。 */
function extractObject(text: string): unknown | null {
  const withoutFences = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const candidates = [withoutFences.trim()];
  const first = withoutFences.indexOf("{");
  const last = withoutFences.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(withoutFences.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

/** 日本語ラベルの自由文（archive と同じ形）から各欄を拾う。 */
function fromLabeledText(text: string): Partial<Record<(typeof FIELDS)[number], string>> {
  const found: Partial<Record<(typeof FIELDS)[number], string>> = {};
  const pattern = /(理解|根拠|接続|未解決|修正)[：:]\s*([\s\S]*?)(?=\n?\s*(?:理解|根拠|接続|未解決|修正)[：:]|$)/g;
  for (const match of text.matchAll(pattern)) {
    const field = JAPANESE_LABELS[match[1]];
    const value = match[2].trim();
    if (field && value && !found[field]) found[field] = value;
  }
  return found;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(" / ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${asText(entry)}`)
      .join(" / ");
  }
  return "";
}

function asStop(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(true|yes|はい|1|stop|中止|離脱)$/i.test(value.trim());
  return false;
}

/** 表示・保存用の文面。archive の逐次ログと同じ並びにする。 */
export function formatNote(note: Omit<ReaderNote, "index" | "structured">): string {
  return [
    `理解：${note.understanding}`,
    `根拠：${note.evidence}`,
    `接続：${note.connection}`,
    `未解決：${note.unresolved}`,
    `修正：${note.revision}`,
  ].join("\n");
}

/** 読者の応答を1件の記録にする。JSONが取れなければ自由文として保持する。 */
export function parseReaderNote(text: string, index: number): ReaderNote {
  const object = extractObject(text);
  const source: Partial<Record<(typeof FIELDS)[number], string>> = object
    ? Object.fromEntries(
        FIELDS.map((field) => [field, asText((object as Record<string, unknown>)[field])]).filter(([, value]) => value),
      )
    : fromLabeledText(text);

  const understanding = source.understanding ?? "";
  const structured = Boolean(object) && understanding.length > 0;

  const note = {
    understanding: understanding || (structured ? "なし" : text.trim()),
    evidence: source.evidence ?? "なし",
    connection: source.connection ?? "なし",
    unresolved: source.unresolved ?? "なし",
    revision: source.revision ?? "なし",
    stop: asStop(object ? (object as Record<string, unknown>).stop : undefined),
  };

  return { index, ...note, structured };
}
