/**
 * Port of `skills/revise-and-resubmit/scripts/language.py` and the presentation
 * logic in `feed.py` (`chunk` / `BRIEFING` / `chunk_header` / `chunk_footer`).
 *
 * The Python implementation is the reference. Three behaviours must not drift:
 * (a) the Japanese passage split, (b) "the first three sentences one at a
 * time", and (c) Japanese lengths counted in characters, never word proxies.
 * `feed.py` is where the presentation rule actually lives — porting
 * `language.py` alone silently drops it.
 */

export type Lang = "en" | "ja";

/** A paragraph-scale beat (English). */
export const TARGET_WORDS = 85;
/** Operational chunk bound (English). */
export const MAX_WORDS = 200;
/** Japanese passage target / bound. */
export const JA_TARGET = 300;
export const JA_MAXIMUM = 700;
/** How many opening sentences are exposed one at a time. */
export const OPENING_SENTENCES = 3;

/** Python `len()` counts code points; JS `.length` counts UTF-16 units. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

export function count(text: string, lang: Lang = "en"): number {
  return lang === "ja" ? codePoints(text.replace(/\s/g, "")).length : text.split(/\s+/).filter(Boolean).length;
}

export function unit(lang: Lang): "characters" | "words" {
  return lang === "ja" ? "characters" : "words";
}

/** Keep closing quotation marks with the sentence. ASCII decimals stay intact. */
export function jaSentences(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[\s\S]+?(?:[。！？!?]+[」』”"]*|[.](?=\s|$)|$)/g)) {
    const value = match[0].trim();
    if (value) out.push(value);
  }
  return out;
}

export function jaChunks(text: string, target = JA_TARGET, maximum = JA_MAXIMUM): string[] {
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    for (const sentence of jaSentences(para.trim())) {
      // Bound unpunctuated text too, without deleting characters or inserting spaces.
      let rest = codePoints(sentence);
      while (rest.length > maximum) {
        if (buf) {
          out.push(buf);
          buf = "";
        }
        out.push(rest.slice(0, target).join(""));
        rest = rest.slice(target);
      }
      const value = rest.join("");
      if (buf && codePoints(buf).length + codePoints(value).length + 2 > maximum) {
        out.push(buf);
        buf = "";
      }
      buf += value;
      if (codePoints(buf).length >= target) {
        out.push(buf);
        buf = "";
      }
    }
    if (buf) buf += "\n\n";
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Presentation order. Japanese exposes the opening before later sentences can
 * repair its framing; English groups paragraphs into beats.
 */
export function chunk(text: string, lang: Lang = "en"): string[] {
  if (lang === "ja") {
    const passages = jaChunks(text);
    const opening: string[] = [];
    let remaining = OPENING_SENTENCES;
    while (passages.length && remaining) {
      const sentences = jaSentences(passages.shift() as string);
      opening.push(...sentences.slice(0, remaining));
      const rest = sentences.slice(remaining);
      remaining -= Math.min(remaining, sentences.length);
      if (rest.length) passages.unshift(rest.join(""));
    }
    return [...opening, ...passages];
  }

  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf: string[] = [];
  let bufWords = 0;
  for (const p of paras) {
    const words = p.split(/\s+/).filter(Boolean).length;
    if (words > MAX_WORDS) {
      if (buf.length) {
        out.push(buf.join("\n\n"));
        buf = [];
        bufWords = 0;
      }
      const sentences = [...p.matchAll(/[\s\S]+?(?:[.!?](?=\s|$)|$)/g)].map((m) => m[0]);
      let piece: string[] = [];
      let pieceWords = 0;
      for (const sentence of sentences) {
        let rest = sentence.split(/\s+/).filter(Boolean);
        // a sentence-less blob (transcript, list dump) still gets beats
        while (rest.length > MAX_WORDS) {
          out.push([...piece, ...rest.slice(0, TARGET_WORDS)].join(" "));
          piece = [];
          pieceWords = 0;
          rest = rest.slice(TARGET_WORDS);
        }
        piece.push(...rest);
        pieceWords += rest.length;
        if (pieceWords >= TARGET_WORDS) {
          out.push(piece.join(" "));
          piece = [];
          pieceWords = 0;
        }
      }
      if (piece.length) out.push(piece.join(" "));
      continue;
    }
    // keep a heading attached to the paragraph that follows it
    if (/^#{1,6}\s/.test(p) && bufWords === 0) {
      buf.push(p);
      continue;
    }
    buf.push(p);
    bufWords += words;
    if (bufWords >= TARGET_WORDS) {
      out.push(buf.join("\n\n"));
      buf = [];
      bufWords = 0;
    }
  }
  if (buf.length) out.push(buf.join("\n\n"));
  return out;
}

export function chunkHeader(index: number, chunks: string[], lang: Lang = "en"): string {
  const remaining = chunks.slice(index + 1).reduce((sum, c) => sum + count(c, lang), 0);
  return `--- CHUNK ${index + 1}/${chunks.length} (${remaining} ${unit(lang)} remain after this) ---`;
}

/**
 * The line that tells a reader how to record and advance. `command` is how the
 * reader actually invokes the feed, so the caller passes it (decision record
 * 0004). The heredoc form is not cosmetic: a plain `--log "..."` is expanded by
 * the shell, so backticks in a reader's own words were silently executed and
 * dropped from the log.
 */
export function chunkFooter(command: string): string {
  return [
    "--- record your moment log, then advance. Use this exact form; a plain",
    '--log "..." lets the shell run backticks inside your own text:',
    `${command} next --log - <<'LOG'`,
    "<your log>",
    "LOG",
    "use quit in place of next if your persona stops here ---",
  ].join("\n");
}

/**
 * The incremental-understanding briefing handed to a reader (verbatim from
 * `feed.py`). The web app drives turns itself, so the tool instructions in
 * `chunk_footer` are replaced at prompt-assembly time, not here.
 */
export const BRIEFING =
  "This is an incremental understanding probe, not a test of whether " +
  "you finish or like the article. Use only your persona's prior knowledge, " +
  "text released so far, and your own previous notes. Before advancing, " +
  "record in your own words: current understanding (who does what, to " +
  "what, in which situation); basis (short textual evidence versus " +
  "prior knowledge or inference); how the new material connects to the " +
  "title or previous topic and what it adds; open questions or unresolved " +
  "referents; " +
  "and revisions to earlier interpretations, with the trigger. None is " +
  "a valid answer for uncertainties or revisions. Do not invent problems " +
  "or supply the author's intended thesis. Preserve initial readings " +
  "even when later text repairs them. Fluency and continuation do not " +
  "prove comprehension. Interest is a secondary observation. " +
  "Do not search, open links, inspect future text, or read source/state " +
  "files. You may stop; a requested scope boundary is not abandonment. " +
  "Report only at the resolution actually exposed, never invent a " +
  "clause-level reaction from a whole sentence.";
