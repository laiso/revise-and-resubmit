/**
 * Render the shared R&R redline viewer from source.md and annotations.json.
 * Ported from `skills/revise-and-resubmit/scripts/render_review.py` (decision
 * record 0004).
 *
 * The paragraph numbering is a stored contract, not an implementation detail:
 * `source.md` split on blank lines, the first block dropped as the title, the
 * rest numbered from 1. Every archived run's `annotations.json` anchors its
 * quotes to those numbers, so a Markdown-parser-derived split would move every
 * existing comment.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ASSET_NAMES, resolveAssets } from "./assets.ts";

/** Matches Python's `html.escape(s, quote=True)`. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** The counterpart of `HTMLParser(convert_charrefs=True)` on text nodes. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Escape first. Only explicit HTTP(S) links and inline code are supported, so
 * the markup this produces contains a closed set of tags.
 */
export function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return out.replace(/`([^`]+)`/g, "<code>$1</code>");
}

interface Node {
  kind: "tag" | "text";
  value: string;
}

/** Splits `inline()` output into raw tags and decoded text. */
function nodes(markup: string): Node[] {
  const out: Node[] = [];
  let index = 0;
  for (const match of markup.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    const start = match.index as number;
    if (start > index) out.push({ kind: "text", value: decodeEntities(markup.slice(index, start)) });
    out.push({ kind: "tag", value: match[0] });
    index = start + match[0].length;
  }
  if (index < markup.length) out.push({ kind: "text", value: decodeEntities(markup.slice(index)) });
  return out;
}

/** Python `len()` and slicing count code points; JS string indexes do not. */
function codePoints(value: string): string[] {
  return Array.from(value);
}

function byLongestThenValue(a: string, b: string): number {
  const lengths = codePoints(b).length - codePoints(a).length;
  if (lengths !== 0) return lengths;
  const left = codePoints(a);
  const right = codePoints(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const diff = (left[i].codePointAt(0) as number) - (right[i].codePointAt(0) as number);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

export function highlight(markup: string, quotes: Iterable<string>): string {
  const parsed = nodes(markup);
  const text = parsed
    .filter((node) => node.kind === "text")
    .map((node) => node.value)
    .join("");
  const selected = new Array<boolean>(codePoints(text).length).fill(false);
  for (const quote of [...new Set(quotes)].sort(byLongestThenValue)) {
    const visible = nodes(inline(quote))
      .filter((node) => node.kind === "text")
      .map((node) => node.value)
      .join("");
    if (!visible) continue;
    const found = text.indexOf(visible);
    if (found < 0) continue;
    const start = codePoints(text.slice(0, found)).length;
    for (let i = start; i < start + codePoints(visible).length; i += 1) selected[i] = true;
  }
  const output: string[] = [];
  let offset = 0;
  for (const node of parsed) {
    if (node.kind === "tag") {
      output.push(node.value);
      continue;
    }
    let active = false;
    const chars = codePoints(node.value);
    for (let index = 0; index < chars.length; index += 1) {
      const marked = selected[offset + index];
      if (marked !== active) {
        output.push(marked ? "<mark>" : "</mark>");
        active = marked;
      }
      output.push(escapeHtml(chars[index]));
    }
    if (active) output.push("</mark>");
    offset += chars.length;
  }
  return output.join("");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A classic script works under file:// without fetch/CORS or a server. */
function encodePayload(payload: unknown): string {
  return JSON.stringify(payload)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export interface Annotations {
  source_sha256: string;
  comments: { id: string; paragraph: number; quote?: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

export function render(runDir: string, assetsOverride?: string): [number, number] {
  const assets = resolveAssets(assetsOverride);
  const sourceBytes = readFileSync(join(runDir, "source.md"));
  const source = sourceBytes.toString("utf8");
  const data = JSON.parse(readFileSync(join(runDir, "annotations.json"), "utf8")) as Annotations;
  if (data.source_sha256 !== sha256(sourceBytes)) {
    throw new Error("source.md does not match annotation source hash");
  }
  const blocks = source.trim().split(/\n\s*\n/);
  // `lstrip('# ')`: leading hashes and spaces only.
  const title = (blocks.shift() as string).replace(/^[# ]+/, "");
  for (const comment of data.comments) {
    if (!(comment.paragraph >= 1 && comment.paragraph <= blocks.length)) {
      throw new Error(`Invalid paragraph anchor: ${comment.id}`);
    }
    if (comment.quote && !blocks[comment.paragraph - 1].includes(comment.quote)) {
      throw new Error(`Quote mismatch: ${comment.id}`);
    }
  }
  const paragraphs = blocks.map((block, index) => {
    const number = index + 1;
    const quotes = data.comments
      .filter((c) => c.paragraph === number && c.quote)
      .map((c) => c.quote as string);
    return { number, html: highlight(inline(block), quotes) };
  });
  const payload = { ...data, title, paragraphs };
  writeFileSync(join(runDir, "review-data.js"), `window.RR_REVIEW = ${encodePayload(payload)};\n`);

  const rel = relative(runDir, assets).split("\\").join("/");
  let page = readFileSync(join(assets, "review.html"), "utf8").replaceAll("@@ASSETS@@", escapeHtml(rel));
  // Content-versioned assets avoid mixing a new form with cached old handlers.
  for (const asset of ASSET_NAMES) {
    const version = sha256(readFileSync(join(assets, asset))).slice(0, 12);
    page = page.replaceAll(`/${asset}"`, `/${asset}?v=${version}"`);
  }
  const version = sha256(readFileSync(join(runDir, "review-data.js"))).slice(0, 12);
  page = page.replaceAll('src="review-data.js"', `src="review-data.js?v=${version}"`);
  writeFileSync(join(runDir, "room.html"), page);
  return [paragraphs.length, data.comments.length];
}
