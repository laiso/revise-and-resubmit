/**
 * 引用の抽出と検証。`skills/revise-and-resubmit/scripts/preview.py` がやっている
 * 「引用が原文に実在すること」の検証を、結果ページ用に移植したもの。
 *
 * `room.md` は空アンカーへの引用の捏造を禁じている。読者のログから引用を拾うときは、
 * その文字列が提示済みの本文に実在することを必ず確かめ、実在しなければ引用を持たせず
 * 位置の説明に置き換える。
 */

export type CommentKind = "observation" | "revision" | "exit" | "aborted";

/**
 * 読者の停止申告ではなく、実行が失敗して止まったことを示す理由。`workflow.ts` が書く。
 * 空の応答やモデルの拒否まで「離脱」として出すと、原稿の問題に見えてしまい、
 * 直しようのないものを直そうとさせる。0002 が「読者の観察」と「打ち切り」を
 * 分けて記録しているので、表示でも分ける。
 */
const ABORT_REASONS = new Set([
  "config_error",
  "empty",
  "silent",
  "refusal",
  "max_tokens",
  "length",
  "reader_error",
]);

/**
 * 止まった記録を、読者の申告と実行の失敗に分ける。役ごとに書き分けると
 * 片方だけ直る。逐次読者も slob-police も、同じ札を同じ関数で読む。
 */
export function stopKind(stopReason?: string): CommentKind {
  return ABORT_REASONS.has(stopReason ?? "") ? "aborted" : "exit";
}

export interface ServedEntry {
  idx: number;
  /** 提示された本文。 */
  text: string;
  /** 読者のログ。 */
  entry: string;
  stop: boolean;
  /** 止まった理由。読者自身の申告なら空か、モデルの通常の終了。 */
  stopReason?: string;
  model?: string;
  at?: number;
  /**
   * 「修正」が本物の訂正だったか。判定役（Jev）の結果を呼び出し側が閾値で
   * 落とし込んで渡す。未判定なら undefined で、正規表現に戻る。
   *
   * 閾値はここに置かない。判定の当たり外れはモデル側の話で、表示の規則ではない。
   */
  revised?: boolean;
}

export interface Annotation {
  idx: number;
  role: string;
  kind: CommentKind;
  /** 原文に実在することが確認できた引用。確認できなければ null。 */
  quote: string | null;
  /** 表示用の短い読解報告。 */
  comment: string;
  /** 読者に残った問い。無ければ空。 */
  unresolved: string;
  status: string;
  /** このカードがまとめた区切りの番号。1つなら1件。 */
  covers: number[];
  /** 元の逐次ログ。表示編集の前の記録を必ず残す（room.md）。 */
  raw: string;
  /** 打ち手（paper-plot のみ）。代替文ではなく、選択肢の名指し。 */
  options?: string[];
  /**
   * 引用の周りだけを切り出した窓。**画面に出すのはここだけ**で、原稿の全文は
   * 送らない。透明度で隠すのは見た目だけの処理で、本文は DOM に残ってしまう。
   * 量を抑えるには実際に切る必要がある。
   */
  window: { before: string; quote: string; after: string; headTrimmed: boolean; tailTrimmed: boolean } | null;
}

/** 引用の前後に見せる文字数。文が1つ読める程度に留める。 */
const WINDOW_CHARS = 60;

/**
 * 提示済み本文のうち、抜粋として出してよい上限の割合。
 * 引用と論評という形をとる以上、全体に対する再現量を抑える必要がある。
 */
const MAX_COVERAGE = 0.25;

function cutWindow(source: string, quote: string | null) {
  if (!quote) return null;
  const at = source.indexOf(quote);
  if (at < 0) return null;
  const from = Math.max(0, at - WINDOW_CHARS);
  const to = Math.min(source.length, at + quote.length + WINDOW_CHARS);
  return {
    before: source.slice(from, at),
    quote,
    after: source.slice(at + quote.length, to),
    headTrimmed: from > 0,
    tailTrimmed: to < source.length,
  };
}

/** 「修正：」の後に実質的な内容があるときだけ修正とみなす。 */
const REVISION = /修正[：:]\s*(?!\s*(?:なし|無し|特になし|とくになし|－|—|-))(?=\S)/;
const QUOTED_LAZY = /「([\s\S]*?)」/g;
const QUOTED_GREEDY = /「([\s\S]*)」/;
const DOUBLE_QUOTED = /“([\s\S]*?)”/g;

function quoteCandidates(comment: string): string[] {
  const found: string[] = [];
  for (const match of comment.matchAll(QUOTED_LAZY)) found.push(match[1]);
  for (const match of comment.matchAll(DOUBLE_QUOTED)) found.push(match[1]);
  // 入れ子の「」を1つの引用として拾う（入れ子の内側で切れると引用が不自然になる）。
  const greedy = comment.match(QUOTED_GREEDY);
  if (greedy) found.push(greedy[1]);
  return found.map((value) => value.trim()).filter(Boolean);
}

/**
 * ログ中の引用のうち、提示済み本文に実在し、**場所を特定できる最短のもの**を返す。
 *
 * 以前は最長のものを選んでいた（錨としての精度は上がる）。ただし引用と論評という
 * 形をとる以上、再現する量は少ないほうがよい。前後の窓が文脈を補うので、引用自体は
 * 短くてよい。ただし本文中に何度も現れる短い語は場所を特定できないので、
 * **一度しか現れないもののうち最短**を選ぶ。
 */
export function extractQuote(comment: string, source: string): string | null {
  const valid = quoteCandidates(comment).filter((quote) => source.includes(quote));
  if (!valid.length) return null;
  // 入れ子の「」の途中で切れた候補は、短くても引用として不格好なので外す。
  const balanced = valid.filter((quote) => {
    let depth = 0;
    for (const char of quote) {
      if (char === "「") depth += 1;
      if (char === "」") depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0;
  });
  const usable = balanced.length ? balanced : valid;
  const unique = usable.filter((quote) => source.indexOf(quote) === source.lastIndexOf(quote));
  const pool = unique.length ? unique : usable;
  return pool.reduce((shortest, quote) => (quote.length < shortest.length ? quote : shortest));
}

export function isRevision(comment: string): boolean {
  return REVISION.test(comment);
}

/** 「未解決：」に実質的な内容があるか。「なし」は有効な答えなので数えない。 */
const UNRESOLVED = /未解決[：:]\s*(?!\s*(?:なし|無し|特になし|とくになし|－|—|-))(?=\S)/;

function field(entry: string, label: string): string {
  const match = entry.match(new RegExp(`${label}[：:]\\s*(.*)`));
  return match ? match[1].trim() : "";
}

/** 最初の1文だけ取る。余白の独り言にするには、説明を足さないほうがよい。 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const at = trimmed.search(/[。．]/);
  return at < 0 ? trimmed : trimmed.slice(0, at + 1);
}

/**
 * 表示用の短い読解報告を作る。**読者が書いた文をそのまま使い、足さない。**
 *
 * 逐次ログの項目名（理解／根拠／接続／未解決／修正）を画面に出さない（room.md）。
 * さらに各項目の**最初の1文だけ**にする。全部つなぐと1枚が4〜5行になり、8枚並ぶと
 * 読み切れない。欲しいのは編集者が余白に書く独り言で、要約の集積ではない。
 * 元のログは `raw` に残すので、削った分は失われない。
 */
function report(entry: string, revised?: boolean): string {
  const understanding = field(entry, "理解");
  const revision = field(entry, "修正");
  if ((revised ?? isRevision(entry)) && revision) return firstSentence(revision);
  if (understanding) return firstSentence(understanding);
  // 項目が1つも取れないログ（構造化に失敗したもの）は、そのまま出す。
  // ただし未解決だけ取れている場合は、そちらが全文を担うので空にする。
  return unresolvedOf(entry) ? "" : entry.trim();
}

/**
 * 読者に残った問い。理解と全角スペースでつないで1段落にすると、どこからが
 * 疑問なのか読めない。元のログでは別の項目なので、別のまま画面へ渡す。
 */
function unresolvedOf(entry: string): string {
  const unresolved = field(entry, "未解決");
  return UNRESOLVED.test(entry) && unresolved ? firstSentence(unresolved) : "";
}

/**
 * 区切りごとの逐次ログを、読み手が追える数のカードにまとめる。
 *
 * カードを分けるのは、理解が変わった／未解決が残った／離脱した区切り。
 * 続けて何も起きなかった区切りは1枚にまとめる（アーカイブの readme-02 は
 * 10区切りの読書を5件のコメントにしていた）。まとめた場合はその区間の最後の
 * 理解を出す。これは表示上の編集であり、新しい読書結果ではない。
 */
export function buildAnnotations(
  entries: ServedEntry[],
  role = "mind-tail",
  /** 俯瞰型（paper-plot）の指摘。区切りに紐づかず、全体についての観察。 */
  /**
   * 区切りごとの記録に乗らない指摘。俯瞰型（paper-plot、全体について）と、
   * 逐次だが1件だけの離脱（slob-police、場所がある）の両方が来る。
   * `covers` があれば場所あり、無ければ全体について。
   */
  overview: Array<{ quote: string; comment: string; role?: string; options?: string[]; covers?: number[]; kind?: CommentKind }> = [],
): Annotation[] {
  const out: Annotation[] = [];
  let pending: ServedEntry[] = [];

  const flush = () => {
    if (!pending.length) return;
    // まとめた区間は、最後の理解がその時点の到達点。
    const last = pending[pending.length - 1];
    out.push({
      idx: pending[0].idx,
      role,
      kind: "observation",
      quote: extractQuote(last.entry, last.text),
      comment: report(last.entry, last.revised),
      unresolved: unresolvedOf(last.entry),
      status: "観察",
      covers: pending.map((entry) => entry.idx),
      raw: pending.map((entry) => entry.entry).join("\n\n"),
      window: cutWindow(last.text, extractQuote(last.entry, last.text)),
    });
    pending = [];
  };

  for (const entry of entries) {
    // 判定があればそれを使う。無ければ自己申告（正規表現）に戻る。
    // ここを kind だけに効かせると、判定で落ちた「修正」がカードを1枚割ってしまい、
    // 見出しだけ消えた札が残る。区切るかどうかも同じ値で決める。
    const revised = entry.revised ?? isRevision(entry.entry);
    const notable = entry.stop || revised || UNRESOLVED.test(entry.entry);
    if (!notable) {
      pending.push(entry);
      continue;
    }
    flush();
    const kind: CommentKind = entry.stop
      ? stopKind(entry.stopReason)
      : revised
        ? "revision"
        : "observation";
    out.push({
      idx: entry.idx,
      role,
      kind,
      quote: entry.stop ? null : extractQuote(entry.entry, entry.text),
      comment: entry.stop ? entry.entry.trim() : report(entry.entry, revised),
      unresolved: entry.stop ? "" : unresolvedOf(entry.entry),
      status: kind === "exit" ? "離脱" : kind === "aborted" ? "中断" : kind === "revision" ? "修正あり" : "観察",
      covers: [entry.idx],
      raw: entry.entry,
      window: entry.stop ? null : cutWindow(entry.text, extractQuote(entry.entry, entry.text)),
    });
  }
  flush();

  // 俯瞰型も同じ窓と同じ上限の処理を通す。別扱いにすると、ここだけ再現量が
  // 膨らんで「原稿は載せていません」が崩れる（実際に161字の抜粋が出た）。
  const sorted = [...entries].sort((a, b) => a.idx - b.idx);
  const served = sorted.map((entry) => entry.text).join("");
  /** 提示済み本文の文字位置から、それが載っていた区切りを割り出す。 */
  const chunkAt = (offset: number): number => {
    let end = 0;
    for (const entry of sorted) {
      end += entry.text.length;
      if (offset < end) return entry.idx;
    }
    return sorted.length ? sorted[sorted.length - 1].idx : -1;
  };
  for (const note of overview) {
    const found = note.quote ? served.indexOf(note.quote) : -1;
    // 引用が実在するなら、それは「全体について」ではなく場所のある指摘。
    // 位置を空のままにすると、帯だけが原稿全体を指して、カードの引用と食い違う。
    const covers = note.covers ?? (found >= 0 ? [chunkAt(found)] : []);
    out.push({
      idx: covers[0] ?? -1,
      role: note.role ?? "paper-plot",
      kind: note.kind ?? "observation",
      quote: found >= 0 ? note.quote : null,
      comment: note.comment,
      unresolved: "",
      status: note.kind === "exit" ? "離脱" : "構造",
      // 空 = 特定の区切りではなく全体について。位置の帯もそう描く。
      covers,
      raw: note.comment,
      options: note.options ?? [],
      window: cutWindow(served, found >= 0 ? note.quote : null),
    });
  }

  return limitCoverage(out, entries);
}

/**
 * 窓どうしが重なる／隣り合うと、つなげて原稿を復元できてしまう。
 * 区切りは連結すると原稿に戻るので、絶対位置を出して境界を詰める。
 * 全体の再現量が `MAX_COVERAGE` を超える場合は、両端から窓を縮める。
 */
function limitCoverage(list: Annotation[], entries: ServedEntry[]): Annotation[] {
  const offset = new Map<number, number>();
  let at = 0;
  for (const entry of [...entries].sort((a, b) => a.idx - b.idx)) {
    offset.set(entry.idx, at);
    at += entry.text.length;
  }
  const served = at;
  if (!served) return list;

  interface Range { annotation: Annotation; from: number; to: number; quoteFrom: number; quoteTo: number }
  const ranges: Range[] = [];
  for (const annotation of list) {
    const w = annotation.window;
    // 俯瞰型は全体から切り出しているので、基準は原稿の先頭（0）。
    const base = annotation.covers.length
      ? offset.get(annotation.covers[annotation.covers.length - 1])
      : 0;
    if (!w || base === undefined) continue;
    const quoteFrom = base + w.before.length;
    ranges.push({
      annotation,
      from: base + Math.max(0, w.before.length - WINDOW_CHARS),
      to: base + w.before.length + w.quote.length + w.after.length,
      quoteFrom,
      quoteTo: quoteFrom + w.quote.length,
    });
  }
  ranges.sort((a, b) => a.from - b.from);

  // 1) 隣との境界を詰める。引用そのものは削らない。
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const cur = ranges[i];
    if (cur.from <= prev.to) {
      const middle = Math.floor((prev.quoteTo + cur.quoteFrom) / 2);
      prev.to = Math.max(prev.quoteTo, Math.min(prev.to, middle - 1));
      cur.from = Math.min(cur.quoteFrom, Math.max(cur.from, middle + 1));
    }
  }

  // 2) 総量の上限。超えていれば、引用を残したまま前後を均等に削る。
  let total = ranges.reduce((sum, r) => sum + (r.to - r.from), 0);
  if (total > served * MAX_COVERAGE && ranges.length) {
    const quoted = ranges.reduce((sum, r) => sum + (r.quoteTo - r.quoteFrom), 0);
    const budget = Math.max(0, served * MAX_COVERAGE - quoted);
    const pad = Math.floor(budget / (ranges.length * 2));
    for (const r of ranges) {
      r.from = Math.max(r.from, r.quoteFrom - pad);
      r.to = Math.min(r.to, r.quoteTo + pad);
    }
    total = ranges.reduce((sum, r) => sum + (r.to - r.from), 0);
  }

  // 3) 詰めた結果を窓に反映する。
  for (const r of ranges) {
    const w = r.annotation.window;
    if (!w) continue;
    const beforeKeep = r.quoteFrom - r.from;
    const afterKeep = r.to - r.quoteTo;
    const before = beforeKeep <= 0 ? "" : w.before.slice(Math.max(0, w.before.length - beforeKeep));
    const after = afterKeep <= 0 ? "" : w.after.slice(0, afterKeep);
    r.annotation.window = {
      ...w,
      before,
      after,
      headTrimmed: w.headTrimmed || before.length < w.before.length,
      tailTrimmed: w.tailTrimmed || after.length < w.after.length,
    };
  }
  return list;
}
