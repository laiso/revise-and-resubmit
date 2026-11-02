/*
 * Derived from awesome-llm-apps/agent_skills/first-reader (Apache-2.0).
 * Modified by laiso: incremental understanding workflow; removed legacy review
 * paths. Ported from `skills/revise-and-resubmit/scripts/feed.py` (decision
 * record 0004). See THIRD_PARTY_NOTICES.md and
 * licenses/first-reader-Apache-2.0.txt in the skill directory.
 *
 * Hands a manuscript out a passage at a time and stores the reader's log before
 * letting it see the next one. The waiting floor is an anti-racing constraint,
 * not a model of human reading speed.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { type Lang, chunk, chunkFooter, chunkHeader, count, unit, BRIEFING } from "@revise-and-resubmit/core";

export interface LogRecord {
  chunk: number;
  quit: boolean;
  entry: string;
  /** Seconds since the epoch, matching the Python `time.time()` this replaced. */
  t: number;
}

export interface Reader {
  name: string;
  persona: string;
  cursor: number;
  started: number | null;
  servedAt: number | null;
  done: boolean;
  quitAt: number | null;
  finalLogged: boolean;
  log: LogRecord[];
}

export interface Payload {
  header?: string;
  text?: string;
  footer?: string;
  index?: number;
  total?: number;
  briefing?: string;
  end?: string;
  error?: string;
  refused?: string;
}

/** Refusing to reuse a session directory is a safety property, not an error path. */
export class SessionExistsError extends Error {}

function token(): string {
  return randomBytes(18).toString("base64url");
}

function now(): number {
  return Date.now() / 1000;
}

/** Operational anti-racing floor; not a model of human reading speed. */
export function dwellFloor(text: string, factor: number, lang: Lang = "en"): number {
  return factor > 0 ? Math.max(2.0, count(text, lang) * factor) : 0.0;
}

export interface FeedOptions {
  runDir: string;
  names: string[];
  personaTitles?: Record<string, string>;
  dwell?: number;
  lang?: Lang;
  /** How a reader invokes this CLI; it goes into the footer readers act on. */
  command?: string;
}

export class Feed {
  readonly chunks: string[];
  readonly words: number;
  readonly lang: Lang;
  readonly runDir: string;
  readonly dwell: number;
  readonly command: string;
  readonly admin = token();
  readonly readers = new Map<string, Reader>();
  closed = false;

  constructor(text: string, options: FeedOptions) {
    this.lang = options.lang ?? "en";
    this.chunks = chunk(text, this.lang);
    this.words = count(text, this.lang);
    this.runDir = options.runDir;
    this.dwell = options.dwell ?? 0;
    this.command = options.command ?? "rr";
    const names = [...options.names];
    if (new Set(names).size !== names.length) throw new Error("Reader names must be unique.");
    // Every name is checked before any directory is made: adding a reader to a
    // run that already holds one must not half-build the new session, and it
    // must never touch the logs already there.
    for (const name of names) {
      if (existsSync(join(this.runDir, name))) {
        throw new SessionExistsError(`Session already exists: ${join(this.runDir, name)}`);
      }
    }
    for (const name of names) {
      mkdirSync(join(this.runDir, name), { recursive: true });
      writeFileSync(join(this.runDir, name, "log.jsonl"), "");
      this.readers.set(token(), {
        name,
        persona: options.personaTitles?.[name] ?? name,
        cursor: 0,
        started: null,
        servedAt: null,
        done: false,
        quitAt: null,
        finalLogged: false,
        log: [],
      });
    }
  }

  private payload(r: Reader): Payload {
    const i = r.cursor;
    r.servedAt = now();
    return {
      header: chunkHeader(i, this.chunks, this.lang),
      text: this.chunks[i],
      footer: chunkFooter(this.command),
      index: i + 1,
      total: this.chunks.length,
    };
  }

  start(r: Reader): Payload {
    if (r.done) return { error: "Session already finished." };
    const first = r.started === null;
    if (first) r.started = now();
    const p = this.payload(r);
    p.briefing = first
      ? `SESSION ${r.name} | persona: ${r.persona} | ${this.chunks.length} chunks, ` +
        `${this.words} ${unit(this.lang)} total\n${BRIEFING}`
      : "(re-showing the current passage; nothing advanced)";
    return p;
  }

  private record(
    r: Reader,
    entry: string | undefined,
    quit: boolean,
    checkDwell = true,
    chunkNumber?: number,
  ): Payload | null {
    const value = (entry ?? "").trim();
    if (!value) {
      return {
        refused:
          "A log entry is required before advancing or stopping. Record your current understanding or reason to stop.",
      };
    }
    // The dwell floor guards lookahead; quitting reveals nothing, so a reader
    // may leave the instant a passage loses them.
    if (checkDwell && r.servedAt !== null && this.dwell > 0) {
      const floor = dwellFloor(this.chunks[r.cursor], this.dwell, this.lang);
      const waited = now() - r.servedAt;
      if (waited < floor) {
        return {
          refused:
            `Operational waiting period: ${floor.toFixed(0)}s for this passage ` +
            `and ${waited.toFixed(0)}s have passed. Read it, then log what happened.`,
        };
      }
    }
    const rec: LogRecord = { chunk: chunkNumber ?? r.cursor + 1, quit, entry: value, t: now() };
    r.log.push(rec);
    appendFileSync(join(this.runDir, r.name, "log.jsonl"), `${JSON.stringify(rec)}\n`);
    return null;
  }

  next(r: Reader, entry?: string): Payload {
    if (r.done) return { error: "Session already finished." };
    if (r.started === null) return { error: `Call ${this.command} start first.` };
    const bad = this.record(r, entry, false);
    if (bad) return bad;
    r.cursor += 1;
    if (r.cursor >= this.chunks.length) {
      r.done = true;
      this.maybeFinish();
      return {
        end:
          "END OF PIECE. The reader finished. Add one final log line for the ending itself via: " +
          `${this.command} quit --log "final: ..."`,
      };
    }
    return this.payload(r);
  }

  quit(r: Reader, entry?: string): Payload {
    if (r.started === null) return { error: `Call ${this.command} start first.` };
    if (r.finalLogged || (r.done && r.cursor < this.chunks.length)) {
      return { error: "Session already finished." };
    }
    const finished = r.done || r.cursor >= this.chunks.length - 1;
    // A final reaction after END belongs to the last chunk, not cursor + 1.
    const lastChunk = r.done ? this.chunks.length : undefined;
    const bad = this.record(r, entry, !finished, false, lastChunk);
    if (bad) return bad;
    r.done = true;
    r.finalLogged = true;
    r.quitAt = finished ? null : r.cursor + 1;
    r.servedAt = now();
    this.maybeFinish();
    if (r.quitAt) {
      return {
        end:
          `Reader stopped at chunk ${r.quitAt}/${this.chunks.length}. ` +
          "The stop point and its reason have been recorded.",
      };
    }
    return { end: "Final reaction recorded. Session complete." };
  }

  progress(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.readers.values()) {
      out[r.name] = {
        chunk: Math.min(r.cursor + 1, this.chunks.length),
        of: this.chunks.length,
        started: r.started !== null,
        done: r.done,
        quit_at: r.quitAt,
      };
    }
    return out;
  }

  private maybeFinish(): void {
    if ([...this.readers.values()].every((r) => r.done)) this.flush();
  }

  /** Only now does the text touch disk: every reader is finished. */
  flush(): void {
    for (const r of this.readers.values()) {
      const state: Record<string, unknown> = {
        draft: "(served)",
        persona: r.persona,
        chunks: this.chunks,
        cursor: r.cursor,
        done: r.done,
        quit_at: r.quitAt,
        started: r.started ?? now(),
        final_logged: r.finalLogged,
      };
      if (this.lang !== "en") state.language = this.lang;
      writeFileSync(join(this.runDir, r.name, "state.json"), `${JSON.stringify(state, null, 2)}`);
    }
    this.closed = true;
  }
}

// ---------------------------------------------------------------- served mode

export interface ServeHandles {
  server: Server;
  base: string;
  readers: Record<string, string>;
  admin: string;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const piece of req) chunks.push(piece as Buffer);
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createFeedServer(feed: Feed): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value));
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
      res.end(body);
    };
    void (async () => {
      const parts = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
      if (parts.length !== 2) return send(404, { error: "not found" });
      const [key, action] = parts;
      const body = req.method === "POST" ? await readBody(req) : {};
      if (key === feed.admin) {
        if (action === "progress") return send(200, feed.progress());
        if (action === "close") {
          feed.flush();
          send(200, { ok: true, closed: true });
          // Close after the response is on the wire, the way `close` did when
          // it shut the Python server down from its own request thread.
          setImmediate(() => server.close());
          return;
        }
        return send(404, { error: "not found" });
      }
      const reader = feed.readers.get(key);
      if (!reader) return send(404, { error: "not found" });
      const log = typeof body.log === "string" ? body.log : undefined;
      if (action === "start" && req.method === "GET") return send(200, feed.start(reader));
      if (action === "next" && req.method === "POST") return send(200, feed.next(reader, log));
      if (action === "quit" && req.method === "POST") return send(200, feed.quit(reader, log));
      return send(404, { error: "not found" });
    })();
  });
  return server;
}
