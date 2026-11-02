/*
 * Derived from awesome-llm-apps/agent_skills/first-reader (Apache-2.0).
 * Modified by laiso. The command surface of the Python scripts this replaced
 * (`feed.py`, `render_review.py`, `preview.py`, `ask.py`), kept sub-command for
 * sub-command so a habit learned on those still works (decision record 0004).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { Lang } from "@revise-and-resubmit/core";

import { UsageError, bool, flag, flagAll, lang, number, parse, type Parsed } from "./args.ts";
import { ask } from "./ask.ts";
import { Feed, SessionExistsError, createFeedServer } from "./feed.ts";
import { Preview, openBrowser, writeReadyFile } from "./preview.ts";
import { render } from "./render.ts";
import { load, record, save, show, startSession, status, transcript } from "./session.ts";

const USAGE = `revise-and-resubmit — hand a manuscript to a reader one passage at a time.

Served mode (the orchestrator starts this before any reader exists):
  rr serve <draft> --run <run-dir> --readers mind-tail[,slob-police] [--lang ja]
           [--persona name=<one line>] [--dwell 0] [--idle 1800] [--ready-file <path>]
  Give each reader only its own READER_FEED line. Nothing else about the piece.

Reader commands (READER_FEED in the environment, or --feed <address>):
  rr start
  rr next --log - <<'LOG' … LOG        (or --log "…", or --log-file <path>)
  rr quit --log - <<'LOG' … LOG

Orchestrator:
  rr progress --admin <address>
  rr close --admin <address>
  rr transcript <session-dir>
  rr status <session-dir>

File mode (no server; the reader drives a session directory directly):
  rr start <draft> --session <dir> [--persona <name>] [--lang ja]
  rr next <dir> --log …
  rr quit <dir> --log …

Review:
  rr render <run-dir>
  rr preview <run-dir> [--ready-file <path>] [--open-browser] [--port 0]
  rr ask <run-dir> <reader|all> "<question>"

A log entry is required before advancing or stopping. Waiting floors are an
anti-racing constraint, not a measurement of human reading speed.`;

/** How a reader should invoke this CLI, for the footer it acts on. */
function selfCommand(parsed: Parsed): string {
  const override = flag(parsed, "--command");
  if (override) return override;
  const script = process.argv[1];
  if (!script) return "rr";
  return `node ${isAbsolute(script) ? script : resolve(script)}`;
}

function readLog(parsed: Parsed): string {
  const file = flag(parsed, "--log-file");
  if (file) return readFileSync(file, "utf8");
  const value = flag(parsed, "--log");
  if (value === undefined) throw new UsageError("--log is required");
  // `--log -` reads the entry from stdin. A reader's own words routinely
  // contain backticks, and inside `--log "…"` the shell runs them: the command
  // names vanish from the record and are executed on the host. A quoted
  // heredoc into stdin is the form that cannot be expanded.
  return value === "-" ? readFileSync(0, "utf8") : value;
}

async function call(base: string, action: string, payload?: unknown): Promise<Record<string, unknown>> {
  const url = `${base.replace(/\/$/, "")}/${action}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: payload === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`feed unreachable at ${base}: ${(error as Error).message}. Is the feed still running?`);
  }
  if (!response.ok) {
    throw new Error(`feed error: ${response.status} (wrong READER_FEED address or the feed has closed)`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function printServed(result: Record<string, unknown>): void {
  if (typeof result.refused === "string") throw new Error(`REFUSED: ${result.refused}`);
  if (typeof result.error === "string") throw new Error(result.error);
  if (typeof result.briefing === "string") console.log(result.briefing);
  if (typeof result.end === "string") {
    console.log(result.end);
    return;
  }
  console.log(result.header);
  console.log(result.text);
  console.log(result.footer);
}

function servedBase(parsed: Parsed): string | undefined {
  return flag(parsed, "--feed") ?? process.env.READER_FEED ?? undefined;
}

function personaTitles(parsed: Parsed): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const spec of flagAll(parsed, "--persona")) {
    const eq = spec.indexOf("=");
    if (eq > 0) titles[spec.slice(0, eq).trim()] = spec.slice(eq + 1).trim();
  }
  return titles;
}

async function serve(parsed: Parsed): Promise<void> {
  const draft = parsed.positional[1];
  const runDir = flag(parsed, "--run");
  const readers = flag(parsed, "--readers");
  if (!draft || !runDir || !readers) throw new UsageError("serve needs <draft>, --run and --readers");
  const names = readers
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const command = selfCommand(parsed);
  const language: Lang = lang(parsed);
  const dwell = number(parsed, "--dwell", 0);
  const idle = number(parsed, "--idle", 1800);
  const feed = new Feed(readFileSync(draft, "utf8"), {
    runDir,
    names,
    personaTitles: personaTitles(parsed),
    dwell,
    lang: language,
    command,
  });
  const server = createFeedServer(feed);
  await new Promise<void>((done) => server.listen(Number(flag(parsed, "--port") ?? 0), "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("feed did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const addresses: Record<string, string> = {};
  for (const [key, reader] of feed.readers) addresses[reader.name] = `${base}/${key}`;

  console.log(
    `FEED serving ${feed.chunks.length} passages, ${feed.words} ${feed.lang === "ja" ? "characters" : "words"}, ` +
      `readers: ${names.join(", ")}`,
  );
  for (const [name, value] of Object.entries(addresses)) console.log(`reader ${name}: READER_FEED=${value}`);
  console.log(`admin: ${base}/${feed.admin}`);
  console.log("Give each reader ONLY its own READER_FEED line. Nothing else about the piece.");

  const readyFile = flag(parsed, "--ready-file");
  if (readyFile) {
    // The presentation conditions travel with the addresses so the orchestrator
    // can copy them into manifest.json instead of reconstructing them.
    writeReadyFile(readyFile, {
      base,
      admin: `${base}/${feed.admin}`,
      readers: addresses,
      command,
      lang: feed.lang,
      dwell,
      chunks: feed.chunks.length,
    });
  }

  let stopped = false;
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (!feed.closed) feed.flush();
    server.close();
  };
  const lastServed = (): number =>
    Math.max(0, ...[...feed.readers.values()].map((r) => r.servedAt ?? 0));
  const timer = setInterval(() => {
    const now = Date.now() / 1000;
    if (feed.closed) {
      // Every reader is done, but the last one may still be sending its final
      // reaction: stay up until things go quiet.
      if (now - lastServed() > 90) shutdown();
      return;
    }
    const anyoneStarted = [...feed.readers.values()].some((r) => r.started !== null);
    if (idle && anyoneStarted) {
      const last = lastServed();
      if (last && now - last > idle) shutdown();
    }
  }, 5000);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("close", () => {
    clearInterval(timer);
    if (!feed.closed) feed.flush();
  });
}

async function start(parsed: Parsed): Promise<void> {
  const base = servedBase(parsed);
  if (base) return printServed(await call(base, "start"));
  const draft = parsed.positional[1];
  const session = flag(parsed, "--session");
  if (!draft || !session) {
    throw new UsageError("file mode needs: rr start <draft> --session <dir>  (or set READER_FEED)");
  }
  console.log(
    startSession(session, draft, readFileSync(draft, "utf8"), flag(parsed, "--persona"), lang(parsed), selfCommand(parsed)),
  );
}

async function advance(parsed: Parsed, action: "next" | "quit"): Promise<void> {
  const base = servedBase(parsed);
  const entry = readLog(parsed);
  if (base) return printServed(await call(base, action, { log: entry }));
  const session = parsed.positional[1];
  if (!session) {
    throw new UsageError(`file mode needs the session dir: rr ${action} <dir> --log …  (or set READER_FEED)`);
  }
  const state = load(session);
  if (action === "next") {
    if (state.done) throw new Error("Session already finished.");
    record(session, state, entry);
    state.cursor += 1;
    if (state.cursor >= state.chunks.length) {
      state.done = true;
      save(session, state);
      console.log(
        "END OF PIECE. The reader finished. Add one final log line for the ending itself via: " +
          `${selfCommand(parsed)} quit <session> --log "final: ..."`,
      );
      return;
    }
    save(session, state);
    console.log(show(state, state.cursor, selfCommand(parsed)));
    return;
  }
  if (state.final_logged || (state.done && state.cursor < state.chunks.length)) {
    throw new Error("Session already finished.");
  }
  const finished = state.done || state.cursor >= state.chunks.length - 1;
  record(session, state, entry, !finished);
  state.done = true;
  state.final_logged = true;
  state.quit_at = finished ? null : state.cursor + 1;
  save(session, state);
  console.log(
    state.quit_at
      ? `Reader stopped at chunk ${state.quit_at}/${state.chunks.length}. ` +
          "The stop point and its reason have been recorded."
      : "Final reaction recorded. Session complete.",
  );
}

async function preview(parsed: Parsed): Promise<void> {
  const runDir = parsed.positional[1];
  if (!runDir) throw new UsageError("preview needs <run-dir>");
  const server = new Preview(runDir, flag(parsed, "--assets"));
  const http = server.createServer();
  await new Promise<void>((done) => http.listen(number(parsed, "--port", 0), "127.0.0.1", done));
  const ready = { url: `${server.origin}/`, pid: process.pid };
  const readyFile = flag(parsed, "--ready-file");
  if (readyFile) writeReadyFile(readyFile, ready);
  console.log(JSON.stringify(ready));
  if (bool(parsed, "--open-browser")) openBrowser(ready.url);
  process.on("SIGINT", () => http.close());
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const command = parsed.positional[0];
  if (!command || bool(parsed, "--help") || bool(parsed, "-h")) {
    console.log(USAGE);
    if (!command) process.exitCode = 2;
    return;
  }
  try {
    switch (command) {
      case "serve":
        return await serve(parsed);
      case "start":
        return await start(parsed);
      case "next":
      case "quit":
        return await advance(parsed, command);
      case "transcript":
        console.log(transcript(requirePositional(parsed, 1, "transcript needs <session-dir>")));
        return;
      case "status":
        console.log(status(requirePositional(parsed, 1, "status needs <session-dir>")));
        return;
      case "progress":
        console.log(JSON.stringify(await call(requireAdmin(parsed), "progress"), null, 2));
        return;
      case "close":
        console.log(JSON.stringify(await call(requireAdmin(parsed), "close", {})));
        return;
      case "render": {
        const [paragraphs, comments] = render(
          requirePositional(parsed, 1, "render needs <run-dir>"),
          flag(parsed, "--assets"),
        );
        console.log(`Rendered paragraphs/comments: (${paragraphs}, ${comments})`);
        return;
      }
      case "preview":
        return await preview(parsed);
      case "ask": {
        const [, runDir, who, question] = parsed.positional;
        if (!runDir || !who || question === undefined) {
          throw new UsageError('ask needs <run-dir> <reader|all> "<question>"');
        }
        console.log(ask(runDir, who, question));
        return;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof SessionExistsError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

function requirePositional(parsed: Parsed, index: number, message: string): string {
  const value = parsed.positional[index];
  if (!value) throw new UsageError(message);
  return value;
}

function requireAdmin(parsed: Parsed): string {
  const admin = flag(parsed, "--admin");
  if (!admin) throw new UsageError("--admin <address> is required");
  return admin;
}
