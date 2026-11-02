import liveHtml from "./live.html";
import { RETENTION_DAYS, RETENTION_MS } from "./run-object.ts";

import type { Annotation } from "@revise-and-resubmit/core";

/** 結果ページは原稿本文を載せないので、値は必ずエスケープして描画する。 */
/** 役の肖像。`docs/images/reviewers/` の SVG をそのまま埋め込む。 */
const ROLE_ICON: Record<string, string> = {
  "mind-tail": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"6 10 52 50\" width=\"16\" height=\"16\" aria-hidden=\"true\" class=\"avatar\"><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M22 27 15 20 10 29 13 44 21 40M42 27 49 20 54 29 51 44 43 40M22 25Q32 18 42 25L44 43Q42 53 32 53Q22 53 20 43Z\"/><path d=\"m29 39 3 3 3-3Z M32 42v4m-5 0q5 5 10 0\"/><circle cx=\"26\" cy=\"33\" r=\"1\" fill=\"currentColor\"/><circle cx=\"38\" cy=\"33\" r=\"1\" fill=\"currentColor\"/></g></svg>",
  "slob-police": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"6 10 52 50\" width=\"16\" height=\"16\" aria-hidden=\"true\" class=\"avatar\"><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 26Q19 15 32 15Q45 15 44 26L54 23L50 36L45 38L44 46Q41 55 32 55Q23 55 20 46L19 38L14 36L10 23Z\"/><path d=\"M20 29l9 4m6 0 9-4M25 35h2m10 0h2M30 35l-3 7h10l-3-7M23 46q9 5 18 0M24 46l2-5 3 7m6 0 3-7 2 5M28 20h8\"/></g></svg>",
  "paper-plot": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"6 10 52 50\" width=\"16\" height=\"16\" aria-hidden=\"true\" class=\"avatar\"><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m17 28-1-10 11 5h10l11-5-1 10v13q-1 13-15 14Q18 54 17 41Z\"/><circle cx=\"25\" cy=\"34\" r=\"8\"/><circle cx=\"39\" cy=\"34\" r=\"8\"/><path d=\"m29 44 3 4 3-4\"/><circle cx=\"25\" cy=\"34\" r=\"1.5\" fill=\"currentColor\"/><circle cx=\"39\" cy=\"34\" r=\"1.5\" fill=\"currentColor\"/></g></svg>"
};

/**
 * 役の呼び名。`mind-tail` のような内部の名前を先頭に置かない。
 * 初見の人が最初に読む語が意味不明だと、そこで止まる。名前は括弧に従える。
 */
const ROLE_LABEL: Record<string, string> = {
  "mind-tail": "少しずつ読む読者",
  "slob-police": "言い回しに厳しい読者",
  "paper-plot": "全体を見る目",
};

function roleLabel(role: string): string {
  const label = ROLE_LABEL[role];
  return label ? `${label}（${role}）` : role;
}

function escapeHtml(value: string): string {
  const table: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => table[character]);
}

/** ライブ画面。本人だけの画面なので、鍵は所有鍵1本でよい。 */
export function livePage(owner: string): string {
  return liveHtml.replace("__TOKEN__", owner);
}

/** 状態の英語をそのまま出さない。読む人が使う語にする。 */
const STATUS_LABEL: Record<string, string> = {
  queued: "待機中",
  running: "読んでいます",
  complete: "読み終わりました",
  stopped: "途中で止まりました",
  errored: "失敗しました",
  deleted: "削除済み",
};

/** いつ消えるかは「3日で」ではなく日時で言う。読む人が自分で数えなくてよい。 */
function expiryLabel(createdAt: number): string {
  const at = new Date(createdAt + RETENTION_MS);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/**
 * 見出しの記号は原稿の書式であって、読者が引っかかった文字ではない。
 * 窓に生の `##` が残ると、引用が何を指しているのか一目で分からなくなる。
 * 落とすのは記号だけで、本文の文字は削らない。
 */
function plainText(value: string): string {
  return value.replace(/(^|\n)[ \t]*#{1,6}[ \t]*/g, "$1").replace(/\n{2,}/g, "\n");
}

/**
 * 結果ページ。残るのは引用と指摘だけで、全文は載せない。
 * 引用が原文と照合できなかったコメントは、引用を捏造せず位置の説明に置き換える。
 */
export function resultPage(
  annotations: Annotation[],
  options: {
    /**
     * 閲覧の鍵。読むだけならこれで足りる。共有されてもよい側。
     * 削除の鍵（`owner`）とは別にする。1本の鍵で読みと削除を兼ねると、
     * 結果を人に見せた時点で、その相手に消す権限まで渡ってしまう。
     */
    view: string;
    /** 所有の鍵。持っている本人にだけ削除を出す。閲覧リンクからは来ない。 */
    owner?: string;
    status: string;
    /** 止まった理由。サーバーが言い切れたときだけ入る（進捗の途絶え、設定の誤りなど）。 */
    reason?: string;
    total: number;
    title: string;
    model?: string;
    install?: string;
    /** Run の作成時刻（ミリ秒）。いつ消えるかを日時で出すために使う。 */
    createdAt?: number;
    /** 元記事のURL（URL入稿のとき）。出所として必ず出す。 */
    sourceUrl?: string;
    /**
     * 読ませる前に進行役が調べて、想定読者の既知として渡した語（決定記録 0003）。
     * これを出さないと、読者が何を知っている前提だったのかが著者に分からない。
     */
    knownTerms?: Array<{ term: string; gloss: string }>;
    /** 進行役が調べても確認できなかった語。読者には渡していない。 */
    unknownTerms?: string[];
    /**
     * 字数の上限で末尾を落とした場合の段落数。落としたことを言わないと、
     * 構成についての指摘が「記事の終わり」を指しているように読めてしまう。
     */
    truncated?: { paragraphs: number; total: number };
  },
): string {
  // 役の呼び名は、2種類以上の声が出ているときだけ出す。1種類しかない画面では
  // 同じ語が並ぶだけで、情報がない。3役が並ぶときは、別人の発言だと分からないと
  // 1人のレビュアーが矛盾しているように読めるので、そのときは要る。
  // ただし毎枚に出すと、27枚が同じ語になり、どれが誰の発言かの区別に使えない。
  // 役が切り替わった枚にだけ出し、内部の名前は上の凡例に1回だけ置く。
  const roles = [...new Set(annotations.map((annotation) => annotation.role))];
  const showRole = roles.length > 1;

  // 帯が原稿の位置を示す以上、並びも原稿の順でなければ嘘になる。役ごとに
  // 固めると帯の濃い部分が途中で上へ跳ね、離脱が末尾に回る。
  const located = annotations
    .filter((annotation) => annotation.covers.length > 0)
    .sort((a, b) => (a.covers[0] ?? a.idx) - (b.covers[0] ?? b.idx));
  const whole = annotations.filter((annotation) => annotation.covers.length === 0);
  const ordered = [...whole, ...located];

  // 内訳は言葉で並べない。役ごとの件数として、絞り込みの札の上に置く。
  // 読む人が数えたいのは「誰が何件言ったか」で、造語の分類ではない。
  const perRole = new Map<string, number>();
  for (const annotation of annotations) {
    perRole.set(annotation.role, (perRole.get(annotation.role) ?? 0) + 1);
  }

  // 原稿は載せない。引用の周りを切り出した窓だけを、指摘に覆われた形で出す。
  // 覆うのは見た目の主従を示すためで、量を抑えているのは切り出しのほう。
  let previousRole = "";
  const strips = ordered
    .map((annotation, index) => {
      const w = annotation.window;
      // 帯の中の位置。0〜1で渡し、CSS 側で固定の高さに掛ける。
      // 付箋ごとに高さが違うので、% を使うと同じ位置が別々に見えてしまう。
      // covers が空なのは、場所を持たない指摘。帯は全部濃くする。
      const wide = annotation.covers.length === 0;
      const position = wide || !options.total
        ? 0
        : Math.min(1, (annotation.covers[0] ?? annotation.idx) / options.total);
      // まとめた区間は、帯の濃い部分を長くして示す。「2断片ぶん」という言葉は
      // こちらの提示の単位であって、読む人には意味がない（room.md）。
      const span = wide || !options.total ? 1 : Math.min(1, annotation.covers.length / options.total);
      // 引用が無い理由は3つあって、同じ文言で済ませると場所の有無を取り違える。
      const missing =
        annotation.kind === "aborted"
          ? "（ここで実行が止まりました）"
          : annotation.kind === "exit"
            ? "（やめた箇所の引用は残っていません）"
            : "（この指摘は特定の一文ではなく、全体について）";
      const excerpt = w
        ? `<p class="excerpt">${w.headTrimmed ? "…" : ""}${escapeHtml(plainText(w.before))}` +
          `<mark>${escapeHtml(plainText(w.quote))}</mark>` +
          `${escapeHtml(plainText(w.after))}${w.tailTrimmed ? "…" : ""}</p>`
        : `<p class="excerpt none">${missing}</p>`;
      // 「↻ 理解が変わった」は外した。付いていても著者の行動が変わらず、
      // 判定も正規表現で当てにならない（Jev で測ると大半は訂正ではなかった）。
      // 「💭 読んだ感想」も外した。31枚中29枚に付くので、どの枚かを区別できない。
      // 既定値に記号を置くと、例外（理解が変わった枚）の記号と見分けがつかない。
      const roleChanged = annotation.role !== previousRole;
      previousRole = annotation.role;
      const tags: string[] = [];
      // 誰が言ったかは、声が替わった枚にだけ出す。同じ人が続く間は繰り返さない。
      if (showRole && roleChanged) {
        tags.push(ROLE_ICON[annotation.role] ?? "");
        tags.push(`<span class="role">${escapeHtml(ROLE_LABEL[annotation.role] ?? annotation.role)}</span>`);
      }
      if (annotation.kind === "revision") {
        tags.push('<span class="icon" role="img" aria-label="理解が変わった">💡</span>');
      }
      // 止まったことはピルで添えない。このページで最も重要な事実であり、他の
      // 指摘と同じ大きさで出すと区別がつかない。付箋の主文にして、どこで
      // 止まったかを数で書く。文にすれば、色が見えない人にも読める。
      const at = (annotation.covers[0] ?? annotation.idx) + 1;
      const where = options.total && at > 0 ? `（${at}/${options.total}回目）` : "";
      const stopLine =
        annotation.kind === "exit"
          ? `\n  <p class="stopped">ここで読むのをやめた${where}</p>`
          : annotation.kind === "aborted"
            ? `\n  <p class="stopped">読めずに中断${where}</p>`
            : "";
      const tone = annotation.kind === "exit" ? " exit" : annotation.kind === "aborted" ? " aborted" : "";

      return `<section class="strip${tone}" id="a${index + 1}" data-role="${escapeHtml(annotation.role)}" style="--at:${position.toFixed(3)};--span:${span.toFixed(3)}">
 <div class="rail${wide ? " whole" : ""}" aria-hidden="true"><i></i></div>
 <div class="paper">${excerpt}</div>
 <div class="note${annotation.kind === "revision" ? " changed" : ""}${annotation.role === "paper-plot" ? " structure" : ""}" style="--tilt:${index % 2 ? "0.15deg" : "-0.18deg"}">${
   tags.length ? `\n  <div class="head">${tags.join("")}</div>` : ""
 }${stopLine}${
   annotation.comment ? `\n  <p>${escapeHtml(annotation.comment)}</p>` : ""
 }${
   // 理解と問いは元のログでは別の項目。全角スペースでつなぐと、どこからが
   // 疑問なのか読めない。別の段落にして、読み上げにも分かる名前を添える。
   annotation.unresolved
     ? `\n  <p class="asks"><span class="vh">残った問い：</span>${escapeHtml(annotation.unresolved)}</p>`
     : ""
 }${
    annotation.options?.length
      ? `\n  <p class="opt-label">直し方の選択肢</p>\n  <ul class="options">${annotation.options
          .map((option) => `<li>${escapeHtml(option)}</li>`)
          .join("")}</ul>`
      : ""
  }
 </div>
</section>`;
    })
    .join("\n");

  const empty = annotations.length ? "" : '<p class="empty">指摘はありませんでした。</p>';
  // 知識の境界は実験条件。「この読者は何を知っていたか」を結果と一緒に出す。
  const known =
    options.knownTerms?.length || options.unknownTerms?.length
      ? `<section class="known">
 ${
   options.knownTerms?.length
     ? `<h2>この読者が知っている前提で読ませた語</h2>
 <ul>${options.knownTerms
   .map((entry) => `<li><b>${escapeHtml(entry.term)}</b> — ${escapeHtml(entry.gloss)}</li>`)
   .join("")}</ul>`
     : ""
 }${
   options.unknownTerms?.length
     ? `<h2 class="unknown-h">調べても確認できなかった語</h2>
 <ul>${options.unknownTerms.map((term) => `<li><b>${escapeHtml(term)}</b></li>`).join("")}</ul>
 <p class="known-note">読者には渡していません。この語について読者が詰まっている場合、読者の知識不足ではなく原稿側の問題の可能性があります。</p>`
     : ""
 }
 <p class="known-note">読む前に一度だけ調べて渡しました。読者自身は検索していません。</p>
</section>`
      : "";
  const source = options.sourceUrl
    ? `<a class="src" href="${escapeHtml(options.sourceUrl)}" rel="noreferrer noopener">元記事を読む →</a>`
    : "";
  // 離脱も中断も、そこまでスクロールしないと出会えないと意味が薄い。上で一度言う。
  // 中断は「この結果は使えない」という意味なので、離脱より先に出す。
  const notice = (kind: "exit" | "aborted"): string => {
    const at = ordered.findIndex((annotation) => annotation.kind === kind);
    if (at < 0) return "";
    const chunkNo = (ordered[at].covers[0] ?? ordered[at].idx) + 1;
    const text =
      kind === "exit"
        ? `${chunkNo}回目で読むのをやめました →`
        : `${chunkNo}回目で読めずに中断。最後まで読んだ結果ではありません →`;
    // 誰が、は肖像で言う。役名を文に入れると1行で収まらない。
    return `<p class="alert${kind === "aborted" ? " quiet" : ""}"><a href="#a${at + 1}">${
      ROLE_ICON[ordered[at].role] ?? ""
    }${escapeHtml(text)}</a></p>`;
  };
  // 実行そのものが止まった場合。読者の離脱（exit）とも、読者が読めなかった
  // 中断（aborted）とも別で、記録が最後まで無いことの説明はこれしかない。
  const stalled =
    options.status === "errored" && options.reason
      ? `<p class="alert plain">${escapeHtml(options.reason)}</p>`
      : "";
  const notices = stalled + notice("aborted") + notice("exit");
  // 誰が読んだのかは、文で説明せずに肖像と件数で出す。押すと絞り込みになるので、
  // 表示のためだけの要素ではない。1役しかない画面では札を1枚だけ出す。
  const chip = (role: string, label: string, count: number, on: boolean) =>
    `<button type="button" class="chip${on ? " on" : ""}" data-role="${escapeHtml(role)}"${
      showRole ? "" : " disabled"
    }>${ROLE_ICON[role] ?? ""}${escapeHtml(label)}<b>${count}</b></button>`;
  const legend = `<nav class="roles" aria-label="読んだ役で絞り込む">${
    showRole ? chip("", "すべて", annotations.length, true) : ""
  }${roles
    .map((role) => chip(role, ROLE_LABEL[role] ?? role, perRole.get(role) ?? 0, !showRole))
    .join("")}</nav>`;
  const statusLabel = STATUS_LABEL[options.status] ?? options.status;
  const expiry = options.createdAt
    ? `${escapeHtml(expiryLabel(options.createdAt))} に消えます。`
    : `作成から${RETENTION_DAYS}日で消えます。`;

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} — レビュー結果</title>
<style>
 /* 夜に開く画面なので、端末の設定に合わせる。色は必ず変数から取り、
    生の値をここより下に書かない（片方のテーマだけ直る事故を防ぐ）。 */
 :root{color-scheme:light dark;
       --ink:#1f1f1c;--paper:#fbfaf6;--line:#e3e2da;--dim:#7a7a72;--mark:#f0ead6;
       --card:#fff;--excerpt:#5d5d56;--avatar:#8a857c;
       --note:#fffdf4;--note-line:#e0d9bf;
       --note-changed:#fff8e8;--note-changed-line:#d9c98e;--changed-ink:#8a6d1f;
       --note-structure:#f4f7fb;--note-structure-line:#c6d4e4;--structure-ink:#5b7a9e;
       --note-exit:#fff3f0;--note-exit-line:#e3bdb2;--exit-ink:#a33b22;
       --note-abort:#f3f2ee;
       --opt:#4a5b70;--code:#f5f4ee;--link:#2a5db0;--shadow:rgba(31,31,28,.10)}
 @media (prefers-color-scheme:dark){
  :root{--ink:#e7e5dd;--paper:#17171a;--line:#34342f;--dim:#9b998f;--mark:#4a4327;
        --card:#1e1e21;--excerpt:#b6b4ab;--avatar:#8f8c83;
        --note:#22211a;--note-line:#474230;
        --note-changed:#2a2618;--note-changed-line:#685d2d;--changed-ink:#d8bd6e;
        --note-structure:#1b2028;--note-structure-line:#36465a;--structure-ink:#9dbada;
        --note-exit:#2a1a16;--note-exit-line:#68382b;--exit-ink:#e59277;
        --note-abort:#202023;
        --opt:#a2b6cd;--code:#232327;--link:#8ab2ee;--shadow:rgba(0,0,0,.45)}
 }
 body{margin:0;padding:1.4rem 1.2rem 4rem;background:var(--paper);color:var(--ink);
      font:15px/1.9 -apple-system,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
 main{max-width:46rem;margin:0 auto}
 a{color:var(--link)}
 /* 製品名。原稿の題より前に、小さく。ここが何なのか分からないまま
    原稿の題を読むと、そこに書いてあることが誰の主張なのか決められない。 */
 .brand{font-size:11px;letter-spacing:.08em;color:var(--dim);margin:0 0 .2rem;text-transform:uppercase}
 h1{font-size:18px;margin:0 0 .35rem;line-height:1.5}
 .lead{color:var(--dim);font-size:13px;margin:0 0 .2rem;line-height:1.7}
 /* 札は折り返さない。スマホで2段になると、最初の画面の1/10が札で埋まる。 */
 .roles{display:flex;gap:.4rem;flex-wrap:nowrap;overflow-x:auto;margin:.7rem 0 1.1rem;
        scrollbar-width:none;-webkit-overflow-scrolling:touch}
 .roles::-webkit-scrollbar{display:none}
 .chip{flex:none}
 .chip{display:inline-flex;align-items:center;gap:.35rem;font:inherit;font-size:12px;
       padding:.25rem .65rem;border:1px solid var(--line);border-radius:99px;
       background:var(--card);color:var(--dim);cursor:pointer}
 .chip[disabled]{cursor:default}
 .chip.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
 .chip.on .avatar{color:var(--paper)}
 .chip b{font-weight:600;font-variant-numeric:tabular-nums;opacity:.7}
 /* 読み上げには要るが、画面では場所を取る言葉を隠す。 */
 .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
     clip-path:inset(50%);white-space:nowrap;border:0}
 .alert{margin:0 0 1.4rem;padding:.5rem .7rem;border:1px solid var(--note-exit-line);
        border-radius:6px;background:var(--note-exit);font-size:13px}
 .alert a{display:flex;align-items:center;gap:.4rem;color:var(--exit-ink);font-weight:700;text-decoration:none}
 /* 実行が止まっただけの知らせ。読者の離脱と同じ強さで出さない。 */
 .alert.quiet{border-color:var(--line);background:var(--note-abort)}
 .alert.quiet a{color:var(--dim)}
 .alert a:hover{text-decoration:underline}
 /* 押す先が無い知らせ（実行が止まった理由）。リンクと同じ見た目にしない。 */
 .alert.plain{color:var(--exit-ink);font-weight:700}
 .strip{position:relative;margin:0 0 2.6rem;padding-left:1.6rem;scroll-margin-top:1.5rem}
 /* 左の細い帯。原稿全体のどのあたりかを、本文を出さずに示す。 */
 /* 原稿全体を表す帯。高さは付箋によらず固定。濃い部分がこの指摘の位置。 */
 .rail{position:absolute;left:0;top:.5rem;height:64px;width:3px;background:var(--line);border-radius:2px}
 /* 濃い部分が帯の外へ出ないように、上端と高さを 64px の中で閉じる。 */
 .rail i{position:absolute;left:0;width:3px;background:var(--ink);border-radius:2px;
         top:calc(var(--at) * 56px);
         height:clamp(8px, calc(var(--span) * 64px), calc(64px - var(--at) * 56px))}
 /* 場所を持たない指摘。1点で示さない。 */
 .rail.whole i{height:100%;top:0;background:var(--structure-ink)}
 .paper{background:var(--card);border:1px solid var(--line);border-radius:3px;padding:1.1rem 1.2rem}
 /* 原稿の改行を残す。見出しと本文が1行に混ざると、引用の範囲が読めない。 */
 .excerpt{margin:0;color:var(--excerpt);white-space:pre-wrap}
 .excerpt mark{background:var(--mark);color:var(--ink);padding:.05em .15em;border-radius:2px}
 .excerpt.none{color:var(--dim);font-size:13px;font-style:normal;white-space:normal}
 /* 指摘は紙の上に貼る。覆うことで、原稿が通しで読めるものに見えないようにする。 */
 /* 傾きは紙に見せるためだが、強いと日本語の行が斜めになって読みにくい。小さくする。 */
 .note{position:relative;margin:-1.1rem 0 0 2.2rem;padding:.8rem .95rem;background:var(--note);
       border:1px solid var(--note-line);border-radius:3px;box-shadow:0 6px 18px var(--shadow);
       transform:rotate(var(--tilt))}
 .note.changed{background:var(--note-changed);border-color:var(--note-changed-line)}
 /* 俯瞰型（paper-plot）。逐次の観察と出所を分けて見せる。 */
 .note.structure{background:var(--note-structure);border-color:var(--note-structure-line)}
 /* 打ち手。代替文ではなく選択肢なので、並べて見せる。 */
 .opt-label{margin:.6rem 0 0;font-size:12px;color:var(--dim)}
 .options{margin:.2rem 0 0;padding-left:1.1rem;color:var(--opt);font-size:13px}
 .options li{margin:.2rem 0}
 /* 読者に残った問い。理解と同じ段落に混ぜない。 */
 .asks{margin:.5rem 0 0;padding-left:.7rem;border-left:2px solid var(--note-line);color:var(--dim)}
 .strip.exit .note{background:var(--note-exit);border-color:var(--note-exit-line)}
 /* 実行が止まっただけの記録。読者の離脱と同じ赤にしない。 */
 .strip.aborted .note{background:var(--note-abort);border-color:var(--line)}
 .strip.aborted .avatar{color:var(--dim)}
 /* 止まったことを言う主文。 */
 .stopped{margin:.5rem 0 0;font-weight:700;color:var(--exit-ink)}
 .strip.aborted .stopped{color:var(--dim)}
 .note p{margin:.35rem 0 0}
 .head{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:12px}
 .icon{font-size:13px;line-height:1}
 .avatar{color:var(--avatar);flex:none}
 .note.changed .avatar{color:var(--changed-ink)}
 .strip.exit .avatar{color:var(--exit-ink)}
 .note.structure .avatar{color:var(--structure-ink)}
 .role{color:var(--dim)}
 .empty{color:var(--dim)}
 .cut{color:#8a8a80;font-size:12px}
 .known{margin:1.4rem 0;padding:.9rem 1rem;border:1px solid #e3e2da;border-radius:10px;background:#fff}
 .known h2{font-size:13px;margin:0 0 .5rem;color:#5a5a52}
 .known ul{margin:0;padding-left:1.1rem;font-size:13px}
 .known li{margin:.25rem 0}
 .unknown-h{margin-top:.9rem}
 .known-note{margin:.6rem 0 0;font-size:12px;color:#8a8a80}
 .share{margin:1.2rem 0 0;font-size:12px;color:#8a8a80}
 .cta{margin:2.5rem 0 1rem;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:10px;background:var(--card)}
 .cta p{margin:0 0 .6rem}
 .cta pre{margin:0;padding:.7rem .8rem;background:var(--code);border-radius:6px;overflow-x:auto}
 .cta code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
 .cta-note{margin:.6rem 0 0;color:var(--dim);font-size:13px}
 .src{display:inline-block;margin:0 0 1.6rem;font-size:13px}
 footer{margin-top:2rem;padding-top:.9rem;border-top:1px solid var(--line);
        color:var(--dim);font-size:12px;display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
 footer a{color:var(--dim)}
 footer button{font:inherit;font-size:12px;padding:.2rem .6rem;border:1px solid var(--note-exit-line);
               background:transparent;color:var(--exit-ink);border-radius:6px;cursor:pointer}
 @media (max-width:640px){ .note{margin-left:.8rem} }
 /* 傾きと影は動きの好みに関わる。減らす設定なら平らに出す。 */
 @media (prefers-reduced-motion:reduce){ .note{transform:none} }
</style></head>
<body>
<main>
<p class="brand">Revise &amp; Resubmit</p>
<h1>${escapeHtml(options.title)}</h1>
<p class="lead">模擬読者に少しずつ読ませた記録です。原稿は載せていません。${
  options.truncated
    ? `<br><span class="cut">元記事の${options.truncated.total}段落のうち、先頭${options.truncated.paragraphs}段落まで（字数の上限）を読ませました。</span>`
    : ""
}</p>
${legend}
${source}
${notices}
${known}
${empty}${strips}
${
  options.install
    ? `<section class="cta">
 <p>手元で使うと、制限なく、長い原稿も読ませられます。原稿を置くプロジェクトで:</p>
 <pre><code>${escapeHtml(options.install)}</code></pre>
 <p class="cta-note">原稿の本文は書き換えません。指摘を読んで、直すのは自分です。</p>
</section>`
    : ""
}${
  options.owner
    ? `<p class="share">この結果を見せるためのリンク（削除はできません）: <code>/v/${escapeHtml(options.view)}/result</code></p>`
    : ""
}<footer>
 <span>この読書1回ぶんの記録（Run）です。${options.total}回に分けて提示 · ${escapeHtml(statusLabel)}${
   options.model ? ` · ${escapeHtml(options.model)}` : ""
 }。${expiry}</span>
 ${options.owner ? `<a href="/r/${escapeHtml(options.owner)}">ライブ画面</a>` : ""}
 ${options.owner ? `<a href="/api/runs/${escapeHtml(options.owner)}/state">状態JSON</a>` : ""}
 ${options.owner ? `<button type="button" id="delete">この Run を今すぐ削除</button>` : ""}
</footer>
</main>
<script>
var chips = document.querySelectorAll(".chip");
for (var i = 0; i < chips.length; i++) {
  chips[i].addEventListener("click", function (event) {
    var role = event.currentTarget.getAttribute("data-role");
    for (var j = 0; j < chips.length; j++) {
      chips[j].classList.toggle("on", chips[j] === event.currentTarget);
    }
    var strips = document.querySelectorAll(".strip");
    for (var k = 0; k < strips.length; k++) {
      strips[k].hidden = Boolean(role) && strips[k].getAttribute("data-role") !== role;
    }
  });
}
${
  options.owner
    ? `document.getElementById("delete").addEventListener("click", function () {
  if (!confirm("この Run を削除します。原稿と逐次ログは復元できません。")) return;
  fetch("/api/runs/${escapeHtml(options.owner)}/delete", { method: "POST" }).then(function () {
    location.reload();
  });
});`
    : ""
}
</script>
</body></html>`;
}

export function landingPage(): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revise &amp; Resubmit</title>
<style>
 body{margin:0;padding:2.5rem 1.2rem;background:#fbfaf6;color:#1f1f1c;
      font:15px/1.8 -apple-system,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
 main{max-width:44rem;margin:0 auto}
 h1{font-size:18px;margin:0 0 .4rem}
 p.note{color:#7a7a72;font-size:13px;margin:0 0 1.2rem}
 .terms{margin:1.6rem 0 0;padding:1rem 1.1rem;border:1px solid #e3e2da;border-radius:10px;background:#fff}
 .terms h2{font-size:14px;margin:0 0 .6rem}
 .terms ul{margin:0;padding-left:1.1rem}
 .terms li{margin:.3rem 0}
 .terms-note{margin:.7rem 0 0;color:#7a7a72;font-size:13px}
 .url{display:block;font-size:13px;color:#7a7a72}
 .url input{width:100%;margin-top:.3rem;padding:.55rem .7rem;border:1px solid #e3e2da;border-radius:8px;
            font:14px/1.6 inherit;background:#fff;color:#1f1f1c}
 .or{margin:.7rem 0 .5rem;font-size:13px;color:#7a7a72}
 textarea{width:100%;min-height:16rem;padding:.8rem;border:1px solid #e3e2da;border-radius:8px;
          font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;color:inherit}
 .row{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-top:.9rem;font-size:13px;color:#7a7a72}
 button{font:inherit;padding:.45rem 1rem;border:1px solid #1f1f1c;background:#1f1f1c;color:#fff;border-radius:6px;cursor:pointer}
 a{color:#2a5db0}
 .gate{margin:0 0 1.2rem;padding:.8rem 1rem;border:1px solid #e0cfa8;border-radius:10px;
       background:#fdf7e8;color:#6b5a2e;font-size:14px}
 .gate b{color:#4a3d1c}
 form[aria-disabled="true"]{opacity:.5}
 .can{margin:1.6rem 0 0;padding:1rem 1.1rem;border:1px solid #e3e2da;border-radius:10px;background:#fff}
 .can h2{font-size:14px;margin:0 0 .6rem}
 .can ul{margin:0;padding-left:1.1rem}
 .can li{margin:.3rem 0}
</style></head>
<body><main>
<h1>Revise &amp; Resubmit</h1>
<p class="note">原稿を渡すと、読者がはじめから順に少しずつ読み、そのつどの理解を書き残します。直しはしません。<b>どこで何を誤解したか</b>が残るだけです。</p>
<div id="gate" class="gate" hidden></div>
<form id="f">
  <label class="url">公開記事の URL
   <input id="url" type="url" placeholder="https://example.com/entry/…" autocomplete="off">
  </label>
  <p class="or">URL を入れると、そのページの本文を取り込んで読みます。自分の原稿をそのまま読ませたいときは、下に貼ってください。</p>
  <textarea id="manuscript" placeholder="# 見出し&#10;&#10;本文をここに貼ります。日本語は最初の3文が1文ずつ提示され、その後は目標300字・上限700字で区切られます。"></textarea>
  <div class="row">
    <label>言語
      <select id="lang"><option value="ja">日本語</option><option value="en">English</option></select>
    </label>
    <label>間隔(ms) <input id="pace" type="number" value="700" min="0" max="10000" step="100" style="width:6rem"></label>
    <button type="submit">入稿する</button>
    <span id="msg"></span>
  </div>
</form>

<section class="can">
 <h2>できること</h2>
 <ul>
  <li><b>URL からでも、貼り付けでも。</b> Zenn・note・はてなブログは本文だけを取り込みます。ほかのページも本文らしいところを拾います。</li>
  <li><b>読者は前に戻れません。</b> 人が読むのと同じで、先を知らないまま順に読みます。だから「ここで詰まった」が分かります。</li>
  <li><b>知らない言葉は先に調べます。</b> 原稿に出てくる製品名などを入稿時に検索して読者に渡すので、「知らないから詰まった」と「書き方で詰まった」が混ざりません。</li>
  <li><b>「理解が変わった」は別に検査します。</b> 読者の自己申告をそのまま信じず、本当に変わったかを判定してから記録します。</li>
  <li><b>人に見せるURLは別に出ます。</b> 共有用のURLからは削除も生ログも辿れません。</li>
 </ul>
</section>

<section class="terms">
 <h2>原稿の扱い</h2>
 <ul>
  <li><b>読ませるために、原稿は外に出ます。</b> レビューはこちらのサーバーで動かし、本文はモデルの提供元にも渡ります。「預からない」は「実行が終われば残らない」という意味であって、「一度も渡らない」ではありません。</li>
  <li><b>3日で消えます。</b> 原稿とログはこのサービスの実行記録として保存され、作成から3日で自動的に消えます。延長はしません。</li>
  <li><b>すぐ消せます。</b> レビュー画面の「この Run を削除」で、その場で消えます。</li>
  <li><b>URLが鍵です。</b> 発行されるURLを知っている人だけが読めます。検索には出しません。人に渡すと、その人も読めます。</li>
  <li><b>本文は書き換えません。</b> 指摘を記録するだけです。直すのは書いた人です。</li>
 </ul>
 <p class="terms-note">未発表の原稿を扱う前提で作っていますが、モデルの提供元の扱いまでは保証できません。差し支えのある原稿は、手元のスキルでお使いください。</p>
</section>

<script>
var form = document.getElementById("f");
var gate = document.getElementById("gate");
// window.closed は読み取り専用なので、closed という名前は使えない
// （代入が黙って無視される）。
var notReady = false;

// 貼る前に聞く。読めない状態なら、入力させてから断らない。
fetch("/api/ready").then(function (r) { return r.json(); }).then(function (data) {
  if (data.ready) return;
  // pointer-events では止まらない。キーボードで入力も送信もできてしまうので、
  // 実際に無効化する。
  notReady = true;
  form.setAttribute("aria-disabled", "true");
  Array.prototype.forEach.call(form.elements, function (el) { el.disabled = true; });
  gate.hidden = false;
  gate.innerHTML = "<b>いま入稿できません。</b> " + (data.message || "");
}).catch(function () { /* 聞けなくても、入稿そのものは止めない */ });

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  if (notReady) return;
  var msg = document.getElementById("msg");
  msg.textContent = "入稿中…";
  var response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: document.getElementById("url").value,
      manuscript: document.getElementById("manuscript").value,
      lang: document.getElementById("lang").value,
      paceMs: Number(document.getElementById("pace").value)
    })
  });
  var data = await response.json();
  if (!response.ok) {
    // allowed が付くのは、モデルの設定が運用者側で間違っているとき。
    // 書き手はモデルを選んでいないので、その名前を見せても何もできない。
    msg.textContent = data.allowed
      ? "いまこのサーバーは原稿を読めません（設定の問題です）。"
      : (data.error || "失敗しました");
    return;
  }
  location.href = data.url;
});
</script>
</main></body></html>`;
}

export function notFoundPage(): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>見つかりません</title>
<style>body{margin:0;padding:3rem 1.2rem;background:#fbfaf6;color:#1f1f1c;
 font:15px/1.8 -apple-system,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
 main{max-width:36rem;margin:0 auto}a{color:#2a5db0}</style></head>
<body><main>
<h1>この Run はありません</h1>
<p>URLが違うか、保持期間（3日）を過ぎて消えたか、削除されたかです。Run は作成時に発行されたURLでしか見られません。</p>
<p><a href="/">入稿画面へ</a></p>
</main></body></html>`;
}
