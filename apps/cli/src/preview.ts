/**
 * Loopback-only review preview with durable human feedback. Ported from
 * `skills/revise-and-resubmit/scripts/preview.py` (decision record 0004).
 *
 * It serves one run directory and the shared assets, nothing else. Feedback
 * written here is the human's own testimony, so it is validated against the
 * manuscript it was written about and stored by an atomic replace: a saved
 * remark must not be lost, and must not survive onto a manuscript that changed
 * underneath it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { ASSET_NAMES, resolveAssets } from "./assets.ts";
import type { Annotations } from "./render.ts";

const REPORTS = new Set([
  "room.html",
  "report.md",
  "structure.md",
  "slob-police.md",
  "annotations.json",
  "source.md",
]);
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const MAX_BODY = 65536;
/** How long to wait for another preview process to finish its write. */
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

/** Thrown for anything the client should see as 409, matching the Python port. */
export class ConflictError extends Error {}

function mediaType(name: string): string {
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? "text/plain";
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): void {
  // A brief synchronous wait: the lock is held only for the duration of one
  // small write, and blocking here keeps the save as simple as the flock it
  // replaced.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicJson(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  const handle = openSync(temporary, "wx");
  try {
    writeSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  const directoryHandle = openSync(directory, "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

/**
 * `fcntl.flock` has no Node equivalent, so an exclusive create stands in for it.
 * A lock left behind by a killed process goes stale and is reclaimed rather
 * than blocking the run forever.
 */
function withLock<T>(path: string, run: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = openSync(path, "wx");
      writeSync(handle, String(process.pid));
      closeSync(handle);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) {
        try {
          unlinkSync(path);
        } catch {
          /* another process reclaimed it first */
        }
        continue;
      }
      if (Date.now() > deadline) throw new ConflictError("Another preview is writing feedback");
      sleep(25);
    }
  }
  try {
    return run();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return named[body.toLowerCase()] ?? match;
  });
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export class Preview {
  readonly run: string;
  readonly assets: string;
  readonly token = randomBytes(32).toString("base64url");
  readonly mediaRoot: string;
  private readonly media = new Map<string, string>();
  private httpServer: Server | null = null;

  constructor(runDir: string, assetsOverride?: string) {
    this.run = realpathSync(runDir);
    this.assets = resolveAssets(assetsOverride);
    this.mediaRoot = Preview.findMediaRoot(this.run);
    // Refuse stale or malformed runs before publishing a URL.
    this.data();
  }

  private static findMediaRoot(run: string): string {
    let current = dirname(run);
    for (;;) {
      try {
        statSync(join(current, ".git"));
        return current;
      } catch {
        /* keep walking */
      }
      const parent = dirname(current);
      if (parent === current) return dirname(run);
      current = parent;
    }
  }

  file(name: string): string {
    const path = join(this.run, name);
    if (lstatSync(path).isSymbolicLink() || dirname(realpathSync(path)) !== this.run) {
      throw new ConflictError("Unsafe run file");
    }
    return path;
  }

  data(): { data: Annotations; source: string } {
    const source = readFileSync(this.file("source.md"));
    const data = JSON.parse(readFileSync(this.file("annotations.json"), "utf8")) as Annotations;
    if (data.source_sha256 !== sha256(source)) {
      throw new ConflictError("source.md does not match annotation source hash");
    }
    if (!Array.isArray(data.comments)) throw new ConflictError("Invalid comments");
    return { data, source: source.toString("utf8") };
  }

  mediaFile(key: string): string | undefined {
    return this.media.get(key);
  }

  mapImages(markup: string): string {
    return markup.replace(
      /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi,
      (whole, head: string, raw: string, tail: string) => {
        const value = decodeEntities(raw);
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//") || value.startsWith("/")) return whole;
        if (value.includes("?") || value.includes("#")) return whole;
        const candidate = join(this.run, value);
        let resolved: string;
        try {
          resolved = realpathSync(candidate);
        } catch {
          return whole;
        }
        if (!IMAGE_SUFFIXES.has(extname(resolved).toLowerCase())) return whole;
        if (!isUnder(resolved, this.mediaRoot)) return whole;
        try {
          if (!statSync(resolved).isFile()) return whole;
        } catch {
          return whole;
        }
        // A symlink anywhere on the way in would let a run point outside itself.
        for (let part = candidate; ; part = dirname(part)) {
          try {
            if (lstatSync(part).isSymbolicLink()) return whole;
          } catch {
            /* a missing component cannot be a symlink */
          }
          if (dirname(part) === part) break;
        }
        const key = sha256(resolved).slice(0, 24);
        this.media.set(key, resolved);
        return `${head}/media/${key}${tail}`;
      },
    );
  }

  saveFeedback(body: Record<string, unknown>): Record<string, unknown> {
    return withLock(join(this.run, ".preview.lock"), () => {
      const { data, source } = this.data();
      if (body.source_sha256 !== data.source_sha256) throw new ConflictError("Source hash mismatch");
      const { paragraph, quote, reaction, request_id: requestId } = body;
      const blocks = source.trim().split(/\n\s*\n/).slice(1);
      if (typeof paragraph !== "number" || !Number.isInteger(paragraph) || !(paragraph >= 1 && paragraph <= blocks.length)) {
        throw new ConflictError("Invalid paragraph");
      }
      if (typeof quote !== "string" || !quote.trim() || !blocks[paragraph - 1].includes(quote)) {
        throw new ConflictError("Quote does not exactly match source paragraph");
      }
      if (typeof reaction !== "string" || !reaction.trim()) throw new ConflictError("Reaction is required");
      if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
        throw new ConflictError("Invalid request_id");
      }
      for (const old of data.comments) {
        if (old.request_id === requestId) {
          if (old.paragraph !== paragraph || old.quote !== quote || old.comment !== reaction) {
            throw new ConflictError("request_id already used for different feedback");
          }
          return old as unknown as Record<string, unknown>;
        }
      }
      const comment = {
        id: `human-${randomBytes(8).toString("hex")}`,
        role: "human-feedbox",
        kind: "human",
        paragraph,
        quote,
        comment: reaction,
        status: "collected/unaddressed",
        request_id: requestId,
        source_sha256: data.source_sha256,
        created_at: new Date().toISOString(),
      };
      data.comments.push(comment as never);
      atomicJson(this.file("annotations.json"), data);
      return comment;
    });
  }

  get origin(): string {
    const address = this.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Preview is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  get port(): number {
    const address = this.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Preview is not listening");
    return address.port;
  }

  createServer(): Server {
    const server = createServer((req, res) => this.handle(req, res));
    this.httpServer = server;
    return server;
  }

  private reply(res: ServerResponse, status: number, value: unknown, contentType?: string): void {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      "Content-Type": contentType ?? "application/json; charset=utf-8",
      "Content-Length": payload.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
  }

  private trustedHost(req: IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${this.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST") {
      void this.handlePost(req, res);
      return;
    }
    if (!this.trustedHost(req)) return this.reply(res, 403, { error: "Invalid Host" });
    // Not percent-decoded, matching the Python path handling this replaced.
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/api/session" || path === "/api/comments" || path === "/review-data.js") {
        const { data } = this.data();
        if (path === "/api/session") {
          return this.reply(res, 200, { source_sha256: data.source_sha256, csrf_token: this.token });
        }
        if (path === "/api/comments") return this.reply(res, 200, { comments: data.comments });
        const raw = readFileSync(this.file("review-data.js"), "utf8");
        const match = /^\s*window\.RR_REVIEW\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(raw);
        if (!match) throw new ConflictError("Unsupported review-data.js format");
        const payload = JSON.parse(match[1]) as Annotations & {
          paragraphs?: { html: string }[];
        };
        if (payload.source_sha256 !== data.source_sha256) {
          throw new ConflictError("Review payload source hash mismatch");
        }
        payload.comments = data.comments;
        for (const paragraph of payload.paragraphs ?? []) paragraph.html = this.mapImages(paragraph.html);
        const encoded = JSON.stringify(payload)
          .replaceAll("<", "\\u003c")
          .replaceAll("\u2028", "\\u2028")
          .replaceAll("\u2029", "\\u2029");
        return this.reply(
          res,
          200,
          Buffer.from(`window.RR_REVIEW = ${encoded};\n`),
          "text/javascript; charset=utf-8",
        );
      }
      if (path.startsWith("/media/")) {
        const media = this.mediaFile(path.slice(7));
        if (media) {
          if (realpathSync(media) !== media || lstatSync(media).isSymbolicLink()) {
            return this.reply(res, 404, { error: "Not found" });
          }
          return this.reply(res, 200, readFileSync(media), mediaType(media));
        }
      }
      const name = path === "/" ? "room.html" : path.replace(/^\//, "");
      if (REPORTS.has(name)) {
        let payload = readFileSync(this.file(name));
        if (name === "room.html") {
          // The served page points at the shared assets over HTTP; the on-disk
          // room.html keeps its relative paths for file:// viewing.
          let page = readFileSync(join(this.assets, "review.html"), "utf8").replaceAll("@@ASSETS@@", "/assets");
          page = page.replace(
            /((?:src|href)=["'])[^"']*\/(review\.css|review\.js|human-feedbox\.js)(\?[^"']*)?(["'])/g,
            "$1/assets/$2$3$4",
          );
          payload = Buffer.from(page);
        }
        return this.reply(res, 200, payload, `${mediaType(name)}; charset=utf-8`);
      }
      if (path.startsWith("/assets/") && (ASSET_NAMES as readonly string[]).includes(path.slice(8))) {
        const asset = join(this.assets, path.slice(8));
        return this.reply(res, 200, readFileSync(asset), `${mediaType(asset)}; charset=utf-8`);
      }
      this.reply(res, 404, { error: "Not found" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.reply(res, 404, { error: "Not found" });
      }
      this.reply(res, 409, { error: "Review files are invalid or source has changed" });
    }
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers["x-csrf-token"];
    const presented = Buffer.from(typeof header === "string" ? header : "");
    const expected = Buffer.from(this.token);
    const sameToken =
      presented.length === expected.length && timingSafeEqual(presented, expected);
    if (!this.trustedHost(req) || req.headers.origin !== this.origin || !sameToken) {
      return this.reply(res, 403, { error: "Invalid request origin or CSRF token" });
    }
    if ((req.url ?? "").split("?")[0] !== "/api/feedback") {
      return this.reply(res, 404, { error: "Not found" });
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return this.reply(res, 415, { error: "Expected application/json" });
    }
    const length = Number(req.headers["content-length"] ?? "0");
    if (req.headers["transfer-encoding"] || !(length > 0 && length <= MAX_BODY)) {
      return this.reply(res, 413, { error: "Invalid body length" });
    }
    try {
      const chunks: Buffer[] = [];
      for await (const piece of req) chunks.push(piece as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ConflictError("Expected object");
      this.reply(res, 200, { comment: this.saveFeedback(body as Record<string, unknown>) });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof SyntaxError || error instanceof TypeError) {
        return this.reply(res, 409, { error: (error as Error).message });
      }
      this.reply(res, 500, { error: "Unable to persist feedback" });
    }
  }
}

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    /* no browser on this host; the URL is on stdout either way */
  });
  child.unref();
}

export function writeReadyFile(path: string, value: unknown): void {
  atomicJson(resolve(path), value);
}
