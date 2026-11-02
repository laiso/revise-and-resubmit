/**
 * URL からの入稿。公開記事の URL を受け取って、読者に提示する本文だけを取り出す。
 *
 * 「自分の原稿を他人のアプリに送る」抵抗を避けるため、最初の一歩は公開 URL で
 * 済むようにしている（plan.md の導線）。したがってここで取るのは、誰でも読める
 * ページの本文だけ。ログインの要る領域や private なアドレスは取りに行かない。
 *
 * 落ちる要素（画像・リンクカードの中身・埋め込み）は、読者に提示していない条件
 * なので数えて manifest に残す。記録の出典は memory の
 * hatena-extraction / note-com-extraction / zenn-extraction。
 */

export interface Ingested {
  text: string;
  title: string;
  /** 正規化した最終 URL（リダイレクト後）。結果ページの出典に出す。 */
  sourceUrl: string;
  /** 読者に渡らなかったもの。原稿の欠けを「原稿の欠陥」と誤読させないため。 */
  dropped: { images: number; embeds: number; links: number };
  /** 長すぎて末尾を落とした場合の、実際に渡した段落数と全体の段落数。 */
  truncated?: { paragraphs: number; total: number };
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** 取り込みの上限。本文そのものの上限（字数）とは別に、転送量で先に止める。 */
const MAX_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const UA = "revise-and-resubmit/0.1 (+https://github.com/laiso/revise-and-resubmit)";

/**
 * 内側に向けさせない。ホスト名が数値アドレスなら私的範囲を弾き、名前なら
 * ループバックと `.internal` 系を弾く。DNS を引いて確かめることまではしない
 * （Workers からは引けない）ので、これは入口の足切りであって完全な防御ではない。
 */
function assertPublic(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new IngestError("http か https の URL だけ取り込めます");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host)
  ) {
    throw new IngestError("このアドレスは取り込めません");
  }
}

async function get(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new IngestError(`記事を取得できませんでした（${response.status}）`, 502);
  }
  // リダイレクト先も公開のアドレスでなければならない。
  assertPublic(new URL(response.url));
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) {
    await response.body?.cancel();
    throw new IngestError("記事が大きすぎます", 413);
  }
  return response;
}

/**
 * HTML から本文を取り出して、断片に割れる形（段落は空行区切り）に直す。
 *
 * 見出しは `## `、箇条書きは `- `、コードは「（コード例）」に潰す。コードを
 * そのまま渡すと、空行のあるコードブロックが複数の断片に割れて、途中の断片が
 * 裸のコード片として提示される（memory: zenn-extraction）。
 */
async function toText(response: Response, selector: string): Promise<{ text: string; title: string; dropped: Ingested["dropped"] }> {
  const out: string[] = [];
  const dropped = { images: 0, embeds: 0, links: 0 };
  let title = "";
  let inTitle = false;
  let skipDepth = 0;

  const push = (value: string) => out.push(value);
  const scope = (name: string) => `${selector} ${name}`;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element() {
        inTitle = true;
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
        if (chunk.lastInTextNode) inTitle = false;
      },
    })
    .on(`${scope("script")}, ${scope("style")}, ${scope("noscript")}`, {
      element(element) {
        skipDepth += 1;
        element.onEndTag(() => {
          skipDepth -= 1;
        });
      },
    })
    .on(scope("pre"), {
      element(element) {
        skipDepth += 1;
        push("\n\n（コード例）\n\n");
        element.onEndTag(() => {
          skipDepth -= 1;
        });
      },
    })
    .on(scope("img"), { element() { dropped.images += 1; } })
    .on(`${scope("iframe")}, ${scope("figure")}, ${scope("video")}`, { element() { dropped.embeds += 1; } })
    .on(scope("a"), { element() { dropped.links += 1; } })
    .on(scope("h1, h2, h3, h4, h5, h6"), { element() { push("\n\n## "); } })
    .on(scope("li"), { element() { push("\n- "); } })
    .on(scope("p, div, section, blockquote, tr, br, hr"), { element() { push("\n\n"); } })
    .on(`${selector}, ${selector} *`, {
      text(chunk) {
        if (!skipDepth) push(chunk.text);
      },
    });

  await rewriter.transform(response).arrayBuffer();

  const text = out
    .join("")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, title: title.replace(/\s+/g, " ").trim(), dropped };
}

/** JSON の本文（HTML 文字列）を、同じ経路に通すための入れ物にする。 */
function asHtml(body: string): Response {
  return new Response(`<article>${body}</article>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * 字数の上限に、**段落の切れ目で**収める。文の途中で切ると、読者には原稿が
 * そこで終わっているように見え、直しようのない指摘が出る。
 */
function fit(text: string, limit: number, measure: (value: string) => number): { text: string; truncated?: Ingested["truncated"] } {
  if (measure(text) <= limit) return { text };
  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const next = [...kept, paragraph].join("\n\n");
    if (measure(next) > limit) break;
    kept.push(paragraph);
  }
  if (!kept.length) throw new IngestError("記事の最初の段落が長すぎます", 413);
  return { text: kept.join("\n\n"), truncated: { paragraphs: kept.length, total: paragraphs.length } };
}

/**
 * URL から原稿を取る。ホストごとに本文の在り処が違うので、そこだけ分ける。
 * どのホストでも、返すのは「段落で割れる素のテキスト」で揃える。
 */
export async function ingestUrl(
  rawUrl: string,
  limit: number,
  measure: (value: string) => number,
): Promise<Ingested> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IngestError("URL として読めません");
  }
  assertPublic(url);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  let extracted: { text: string; title: string; dropped: Ingested["dropped"] };
  let sourceUrl = url.toString();

  if (host === "zenn.dev") {
    // /{user}/articles/{slug} → API。body_html に本文がある（memory: zenn-extraction）。
    const parts = url.pathname.split("/").filter(Boolean);
    const slug = parts[2];
    const user = parts[0];
    if (parts[1] !== "articles" || !slug) throw new IngestError("Zenn の記事 URL ではありません");
    const response = await get(`https://zenn.dev/api/articles/${slug}?username=${encodeURIComponent(user)}`);
    const data = (await response.json()) as { article?: { body_html?: string; title?: string } };
    if (!data.article?.body_html) throw new IngestError("Zenn の本文を取得できませんでした", 502);
    extracted = await toText(asHtml(data.article.body_html), "article");
    if (data.article.title) extracted.title = data.article.title;
  } else if (host === "note.com") {
    // /{user}/n/{key} → API v3。ページの HTML には本文が無い（memory: note-com-extraction）。
    const key = url.pathname.split("/").filter(Boolean).pop();
    if (!key || !key.startsWith("n")) throw new IngestError("note の記事 URL ではありません");
    const response = await get(`https://note.com/api/v3/notes/${key}`);
    const data = (await response.json()) as { data?: { body?: string; name?: string; can_read?: boolean } };
    if (!data.data?.body) throw new IngestError("note の本文を取得できませんでした", 502);
    if (data.data.can_read === false) throw new IngestError("有料部分のある記事は取り込めません");
    extracted = await toText(asHtml(data.data.body), "article");
    if (data.data.name) extracted.title = data.data.name;
  } else {
    const response = await get(sourceUrl);
    sourceUrl = response.url;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html")) {
      await response.body?.cancel();
      throw new IngestError("HTML のページだけ取り込めます");
    }
    // はてなブログは div.entry-content（memory: hatena-extraction）。
    // それ以外は article / main に賭ける。取れなければ本文なしとして断る。
    const selector = host.endsWith("hatenablog.com") || host.endsWith("hatenadiary.jp") || host.endsWith("hateblo.jp")
      ? "div.entry-content"
      : "article, main";
    extracted = await toText(response, selector);
  }

  if (!extracted.text.trim()) throw new IngestError("このページから本文を取り出せませんでした");

  const fitted = fit(extracted.text, limit, measure);
  return {
    text: fitted.text,
    title: extracted.title,
    sourceUrl,
    dropped: extracted.dropped,
    truncated: fitted.truncated,
  };
}
