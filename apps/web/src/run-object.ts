import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

/**
 * Run の実体。原稿・提示済みの断片・逐次ログを SQLite に持ち、WebSocket を
 * hibernation で保持する（決定記録 0002）。
 *
 * 段取りと耐久性は Workflow 側にあり、ここは「書いて配る」だけ。走行中の
 * Workflow の step 出力は外の Worker から読めないため、進捗の置き場と配信口
 * をこの 1 か所に集めている。
 *
 * 未読の断片はここから出さない。`/state` も WebSocket の snapshot も、提示済みの
 * 断片だけを返す（先読みを見せないため）。
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS run (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     token TEXT NOT NULL,
     source TEXT NOT NULL,
     lang TEXT NOT NULL,
     chunks TEXT NOT NULL,
     status TEXT NOT NULL,
     manifest TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS logs (
     idx INTEGER NOT NULL,
     chunk TEXT NOT NULL,
     entry TEXT NOT NULL,
     stop INTEGER NOT NULL DEFAULT 0,
     model TEXT NOT NULL DEFAULT '',
     usage TEXT NOT NULL DEFAULT '',
     stop_reason TEXT NOT NULL DEFAULT '',
     role TEXT NOT NULL DEFAULT 'mind-tail',
     at INTEGER NOT NULL,
     PRIMARY KEY (role, idx)
   )`,
];

/**
 * 既に logs を持つ Run にも stop_reason を足す。壊れた応答（max_tokens での
 * 打ち切り、空応答）が、正常な読書ログと区別できないまま残るのを防ぐため。
 */
const MIGRATIONS = [
  `ALTER TABLE logs ADD COLUMN stop_reason TEXT NOT NULL DEFAULT ''`,
  // 俯瞰型（paper-plot）の指摘。断片に紐づかないので logs には入らない。
  `ALTER TABLE run ADD COLUMN review TEXT NOT NULL DEFAULT ''`,
  // 逐次型が複数になる（mind-tail と slob-police）。役ごとにログを分ける。
  `ALTER TABLE logs ADD COLUMN role TEXT NOT NULL DEFAULT 'mind-tail'`,
  // 「修正」が本物の訂正かどうかの判定値（0〜1）。判定していなければ -1。
  // 正規表現は「なし以外」を数えているだけで、実測では大半が「話が進んだだけ」だった。
  `ALTER TABLE logs ADD COLUMN genuine REAL NOT NULL DEFAULT -1`,
  // 止まった理由。Workflow は前から `status` に添えて送っていたが、捨てていた。
  `ALTER TABLE run ADD COLUMN reason TEXT NOT NULL DEFAULT ''`,
];

/**
 * 入稿の受付を数えるためだけの表。`GATE_NAME` の1インスタンスにしか作られない。
 * 走行中の本数と、その日の受付件数を見る。
 *
 * 終了は `ended_at` に記帳する（正常終了・エラー終了・削除のいずれでも解放する）。
 * 記帳漏れが起きても数が永久に残らないよう、`ACTIVE_WINDOW_MS` を上限とする
 * 時間切れも併用する。以前は記帳をせず時間だけで数えていたが、それだと
 * (1) 終わった Run が10分ぶん枠を占有し、続けて4本走らせると全部終わっていても
 * 5本目が 429 になる、(2) 10分を超える Run（Qwen の実測19.2分）が走行中と
 * 数えられず同時実行の上限が効かない、という2つの穴があった。
 */
const GATE_SCHEMA = `CREATE TABLE IF NOT EXISTS gate (
   token TEXT PRIMARY KEY,
   started_at INTEGER NOT NULL,
   ended_at INTEGER
 )`;

/** 入稿の受付を数える DO インスタンスの名前。Run 本体とは別。 */
export const GATE_NAME = "__limits__";

/**
 * 記帳漏れのときだけ効く時間切れ。最長の実測は Qwen の19.2分なので、
 * 余裕を取って30分。落ちた Run はこの時間だけ枠を1つ占有しうる。
 */
const ACTIVE_WINDOW_MS = 1_800_000;

/**
 * 進捗が途絶えたと見なすまでの時間。超えたら Run を `errored` にする。
 *
 * Workflow 側にも1断片ごとの上限（`CHUNK_TIMEOUT_MS` = 180秒）があるが、あれが
 * 捕まえるのは「読者が遅い」だけで、**step の実行そのものが消えた場合は効かない**。
 * 例外が起きないので、誰も `errored` を書かないまま `running` が残る。実際に、
 * 開発サーバーのホットリロードで中断された Run が、8時間後も `running` /
 * `entries: 0` のままだった（Workflow engine は消えた step を再実行しなかった）。
 * 見張りを Workflow の中に置けないのはこのためで、DO のアラームでしか気付けない。
 *
 * 値は「1断片の中で正当に黙りうる最長」より長く取る。空応答の引き直しで
 * `ask()` が2回（180秒×2）、`judgeRevision`、`paceMs`（最大10秒）が積み上がるので
 * 下限は約370秒。余裕を見て7分。試験では `STALL_MS` で秒単位に落とす。
 */
const STALL_MS = 420_000;

/** 途絶えの見張りの期限。保持期間の満了と1本のアラームを分け合う。 */
const WATCHDOG_KEY = "watchdog_at";

interface RunRow extends Record<string, SqlStorageValue> {
  token: string;
  lang: string;
  chunks: string;
  status: string;
  manifest: string;
  review: string;
  reason: string;
  created_at: number;
}

interface LogRow extends Record<string, SqlStorageValue> {
  idx: number;
  chunk: string;
  entry: string;
  stop: number;
  model: string;
  usage: string;
  stop_reason: string;
  role: string;
  genuine: number;
  at: number;
}

/** 保持期間。結果ページの文言も、実際の削除も、この値から出す。 */
export const RETENTION_DAYS = 3;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class RunObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  private ensureSchema() {
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    // 既に作られた Run にも後から足した列を入れる（SQLite は重複で例外を出すので握る）。
    for (const statement of [
      "ALTER TABLE logs ADD COLUMN usage TEXT NOT NULL DEFAULT ''",
      ...MIGRATIONS,
    ]) {
      try {
        this.ctx.storage.sql.exec(statement);
      } catch {
        // 既にある
      }
    }
  }

  /**
   * アラームは1本しか持てないので、保持期間の満了と進捗の途絶えを畳んで持つ。
   * 起きたときに、どちらの期限だったかをここで見分ける。
   *
   * `deleteAll()` はアラームも一緒に消すので、削除済みの Run で再び起きることはない。
   */
  async alarm(): Promise<void> {
    // 受付を数えるだけのインスタンス（`__limits__`）には run が無い。ここで
    // 抜けないと、満了の後始末が受付の表ごと消してしまう。
    const run = this.ctx.storage.sql
      .exec<{ status: string; token: string; created_at: number }>(
        "SELECT status, token, created_at FROM run WHERE id = 1",
      )
      .toArray()[0];
    if (!run) return;

    const now = Date.now();
    if (now >= run.created_at + RETENTION_MS) {
      await this.purge("expired");
      return;
    }

    const deadline = await this.ctx.storage.get<number>(WATCHDOG_KEY);
    if (typeof deadline === "number" && now >= deadline) {
      // 期限が来た以上、この見張りは役目を終える。走っていようといまいと消す。
      await this.ctx.storage.delete(WATCHDOG_KEY);
      if (run.status === "queued" || run.status === "running") {
        const silent = Math.round((now - (deadline - this.stallMs())) / 1000);
        // 「遅い」ではなく「進んでいない」と言い切る。理由の在り処まで書かないと、
        // 画面を見た人は読者が黙っているのだと受け取ってしまう。
        const reason = `${silent}秒のあいだ進捗がありません。読書の実行が中断されたと見ています（原因はこの Run の外にあります）。`;
        this.ctx.storage.sql.exec("UPDATE run SET status = 'errored', reason = ? WHERE id = 1", reason);
        this.broadcast({ type: "status", status: "errored", reason });
        await this.releaseGate(run.token);
      }
    }
    await this.arm();
  }

  /** 見張りの長さ。試験で秒単位に落とせるよう環境変数で上書きできる。 */
  private stallMs(): number {
    const value = Number(this.env.STALL_MS);
    return Number.isFinite(value) && value > 0 ? value : STALL_MS;
  }

  /** 満了と途絶えの近いほうにアラームを寄せる。 */
  private async arm(): Promise<void> {
    const run = this.ctx.storage.sql
      .exec<{ created_at: number }>("SELECT created_at FROM run WHERE id = 1")
      .toArray()[0];
    if (!run) return;
    const expiresAt = run.created_at + RETENTION_MS;
    const deadline = await this.ctx.storage.get<number>(WATCHDOG_KEY);
    await this.ctx.storage.setAlarm(
      typeof deadline === "number" ? Math.min(expiresAt, deadline) : expiresAt,
    );
  }

  /** 進捗があった。途絶えの時計を巻き直す。 */
  private async touch(): Promise<void> {
    await this.ctx.storage.put(WATCHDOG_KEY, Date.now() + this.stallMs());
    await this.arm();
  }

  /** これ以上進まない。見張りを解いて、残りは保持期間だけにする。 */
  private async rest(): Promise<void> {
    await this.ctx.storage.delete(WATCHDOG_KEY);
    await this.arm();
  }

  /** 原稿とログを落として、受付の枠を返す。削除と満了で共通。 */
  private async purge(why: "deleted" | "expired"): Promise<void> {
    const token = this.ctx.storage.sql
      .exec<{ token: string }>("SELECT token FROM run WHERE id = 1")
      .toArray()[0]?.token;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "status", status: "deleted" }));
        socket.close(1000, why);
      } catch {
        // already gone
      }
    }
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    if (token) await this.releaseGate(token);
  }

  /**
   * 受付の表。`__limits__` インスタンスでしか使わないが、どのインスタンスでも
   * 呼べるようにしておく（呼ばれなければ表を作るだけ）。
   */
  private ensureGate() {
    this.ctx.storage.sql.exec(GATE_SCHEMA);
    // 記帳を足す前に作られた表にも ended_at を入れる（重複は握る）。
    try {
      this.ctx.storage.sql.exec("ALTER TABLE gate ADD COLUMN ended_at INTEGER");
    } catch {
      // 既にある
    }
  }

  /** 走行中＝終了の記帳が無く、時間切れもしていないもの。 */
  private countActive(now: number): number {
    return [...this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM gate WHERE ended_at IS NULL AND started_at > ?",
      now - ACTIVE_WINDOW_MS,
    )][0].n;
  }

  /** 受付の枠を返す。Run 側の DO からも呼ぶので、ここに置く。 */
  private async releaseGate(token: string): Promise<void> {
    try {
      const limits = this.env.RUN.get(this.env.RUN.idFromName(GATE_NAME));
      const response = await limits.fetch("https://run.internal/gate-release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      await response.body?.cancel();
    } catch {
      // 枠が返らないだけなら Run の結果は変わらない。時間切れが後始末する。
    }
  }

  private read(): { run: RunRow; logs: LogRow[] } | null {
    const run = this.ctx.storage.sql.exec<RunRow>("SELECT * FROM run WHERE id = 1").toArray()[0];
    if (!run) return null;
    const logs = this.ctx.storage.sql
      .exec<LogRow>("SELECT * FROM logs ORDER BY role ASC, idx ASC")
      .toArray();
    return { run, logs };
  }

  private total(): number {
    const run = this.ctx.storage.sql.exec<{ chunks: string }>("SELECT chunks FROM run WHERE id = 1").toArray()[0];
    return run ? (JSON.parse(run.chunks) as string[]).length : 0;
  }

  /** 削除と書き込みが競合したときは例外ではなく 410 で伝える。 */
  private alive(): boolean {
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM run").toArray()[0];
    return Boolean(row) && row.n > 0;
  }

  private broadcast(event: unknown) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A socket can disappear between getWebSockets() and send(); it is
        // already closed from the client's side, so drop it.
      }
    }
  }

  private snapshot() {
    const data = this.read();
    const total = this.total();
    if (!data) return { type: "gone", total: 0, cursor: -1, status: "deleted", entries: [] };
    return {
      type: "snapshot",
      status: data.run.status,
      reason: data.run.reason ?? "",
      cursor: data.logs.length ? data.logs[data.logs.length - 1].idx : -1,
      total,
      lang: data.run.lang,
      entries: data.logs.map((log) => ({
        idx: log.idx,
        text: log.chunk,
        entry: log.entry,
        stop: Boolean(log.stop),
        model: log.model,
        usage: log.usage ? JSON.parse(log.usage) : null,
        stopReason: log.stop_reason ?? "",
        role: log.role ?? "mind-tail",
        genuine: typeof log.genuine === "number" ? log.genuine : -1,
        at: log.at,
      })),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");

    if (action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.snapshot()));
      // 期限は延ばさず、仕掛け直すだけ。ランタイムが落ちてアラームを取り
      // こぼしても、誰かが画面を開いた時点で見張りが戻る。
      await this.arm();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (action === "init" && request.method === "POST") {
      const body = (await request.json()) as {
        token: string;
        source: string;
        chunks: string[];
        lang: string;
        manifest: Record<string, unknown>;
      };
      const createdAt = Date.now();
      const existing = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM run").toArray()[0];
      if (existing && existing.n > 0) {
        // Run は不変。同じ実体を書き換えない。
        return Response.json({ error: "run already initialized", immutable: true }, { status: 409 });
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO run (id, token, source, lang, chunks, status, manifest, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
        body.token,
        body.source,
        body.lang,
        JSON.stringify(body.chunks),
        "queued",
        JSON.stringify(body.manifest ?? {}),
        createdAt,
      );
      // 保持期間をここで実行する。「3日で消えます」と書いてあっても、消す処理が
      // なければ原稿は残り続ける。消し方は手動削除と同じで、この1箇所に集める。
      // 同時に途絶えの見張りも始める。Workflow が一度も動かなかった場合は、
      // ここで仕掛けたアラームだけが「始まらなかった」ことを言える。
      await this.touch();
      return Response.json({ ok: true, chunks: body.chunks.length });
    }

    if (action === "append" && request.method === "POST") {
      if (!this.alive()) return Response.json({ error: "run is gone" }, { status: 410 });
      const body = (await request.json()) as {
        idx: number;
        text: string;
        entry: string;
        stop: boolean;
        model: string;
        usage?: unknown;
        stopReason?: string;
        role?: string;
        genuine?: number;
      };
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO logs (idx, chunk, entry, stop, model, usage, stop_reason, role, genuine, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        body.idx,
        body.text,
        body.entry,
        body.stop ? 1 : 0,
        body.model ?? "",
        body.usage ? JSON.stringify(body.usage) : "",
        body.stopReason ?? "",
        body.role ?? "mind-tail",
        typeof body.genuine === "number" ? body.genuine : -1,
        Date.now(),
      );
      const total = this.total();
      const event = {
        type: "append",
        status: "running",
        cursor: body.idx,
        total,
        entries: [
          {
            idx: body.idx,
            text: body.text,
            entry: body.entry,
            stop: Boolean(body.stop),
            model: body.model ?? "",
            usage: body.usage ?? null,
            stopReason: body.stopReason ?? "",
            role: body.role ?? "mind-tail",
            genuine: typeof body.genuine === "number" ? body.genuine : -1,
            at: Date.now(),
          },
        ],
      };
      this.broadcast(event);
      await this.touch();
      return Response.json({ ok: true, cursor: body.idx, total });
    }

    // 入稿の受付可否。Run ごとの DO とは別の、`__limits__` インスタンスだけが使う。
    if (action === "gate" && request.method === "POST") {
      const body = (await request.json()) as { token: string; maxActive: number; maxDaily: number };
      this.ensureGate();
      const now = Date.now();
      // 1日の境界は UTC。表示に使う値ではなく、受付を均すための区切り。
      const midnight = new Date(now).setUTCHours(0, 0, 0, 0);
      this.ctx.storage.sql.exec("DELETE FROM gate WHERE started_at < ?", midnight - 86_400_000);
      const active = this.countActive(now);
      const today = [...this.ctx.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM gate WHERE started_at >= ?",
        midnight,
      )][0].n;
      if (today >= body.maxDaily) {
        return Response.json({ ok: false, reason: "daily", active, today }, { status: 429 });
      }
      if (active >= body.maxActive) {
        return Response.json({ ok: false, reason: "busy", active, today }, { status: 429 });
      }
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gate (token, started_at, ended_at) VALUES (?, ?, NULL)", body.token, now);
      return Response.json({ ok: true, active: active + 1, today: today + 1 });
    }

    // 走行中の本数を見るだけ。`/api/limits` が出す。
    if (action === "gate-peek") {
      this.ensureGate();
      const now = Date.now();
      const midnight = new Date(now).setUTCHours(0, 0, 0, 0);
      const today = [...this.ctx.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM gate WHERE started_at >= ?",
        midnight,
      )][0].n;
      return Response.json({ active: this.countActive(now), today });
    }

    // Run が終わった（または消えた）ので枠を返す。何度呼んでも同じ結果になる。
    if (action === "gate-release" && request.method === "POST") {
      const body = (await request.json()) as { token: string };
      this.ensureGate();
      this.ctx.storage.sql.exec(
        "UPDATE gate SET ended_at = ? WHERE token = ? AND ended_at IS NULL",
        Date.now(),
        body.token,
      );
      return Response.json({ ok: true });
    }

    // 読ませる前の下調べ（決定記録 0003）。manifest に混ぜる。知識の境界は
    // 実験条件なので、結果と同じ場所に、同じ寿命で残す。
    if (action === "presearch" && request.method === "POST") {
      if (!this.alive()) return Response.json({ error: "run is gone" }, { status: 410 });
      const body = (await request.json()) as Record<string, unknown>;
      const row = this.ctx.storage.sql
        .exec<{ manifest: string }>("SELECT manifest FROM run WHERE id = 1")
        .toArray()[0];
      const manifest = row ? (JSON.parse(row.manifest) as Record<string, unknown>) : {};
      manifest.presearch = body;
      this.ctx.storage.sql.exec("UPDATE run SET manifest = ? WHERE id = 1", JSON.stringify(manifest));
      await this.touch();
      return Response.json({ ok: true });
    }

    // 俯瞰型の指摘を保存する。読書が終わってから1回だけ来る。
    if (action === "review" && request.method === "POST") {
      if (!this.alive()) return Response.json({ error: "run is gone" }, { status: 410 });
      const body = (await request.json()) as { notes: unknown; note?: string };
      // note は「なぜ0件だったか」。指摘そのものではないので notes とは別に持つ。
      this.ctx.storage.sql.exec(
        "UPDATE run SET review = ? WHERE id = 1",
        JSON.stringify({ notes: body.notes ?? [], note: body.note ?? "" }),
      );
      this.broadcast({ type: "review", notes: body.notes ?? [], note: body.note ?? "" });
      await this.touch();
      return Response.json({ ok: true });
    }

    if (action === "status" && request.method === "POST") {
      if (!this.alive()) return Response.json({ error: "run is gone" }, { status: 410 });
      const body = (await request.json()) as { status: string; reason?: string };
      // 理由は前から Workflow が送っていた。捨てずに残す。`running` に戻った
      // ときは空で上書きされ、前の失敗の説明が居座らない。
      const reason = typeof body.reason === "string" ? body.reason : "";
      this.ctx.storage.sql.exec("UPDATE run SET status = ?, reason = ? WHERE id = 1", body.status, reason);
      this.broadcast({ type: "status", status: body.status, reason });
      // これ以上進まない状態になったら受付の枠を返す。
      const done = ["complete", "stopped", "errored", "deleted"].includes(body.status);
      if (done) {
        const token = this.read()?.run.token;
        if (token) await this.releaseGate(token);
      }
      // 終わったなら見張りを解く。再実行で `running` に戻ったなら、巻き直す。
      await (done ? this.rest() : this.touch());
      return Response.json({ ok: true, status: body.status });
    }

    if (action === "state") {
      const data = this.read();
      if (!data) return Response.json({ error: "not found" }, { status: 404 });
      await this.arm();
      return Response.json(
        {
          token: data.run.token,
          lang: data.run.lang,
          status: data.run.status,
          reason: data.run.reason ?? "",
          manifest: JSON.parse(data.run.manifest),
          review: data.run.review ? JSON.parse(data.run.review) : { notes: [], note: "" },
          created_at: data.run.created_at,
          total: (JSON.parse(data.run.chunks) as string[]).length,
          entries: data.logs.map((log) => ({
            idx: log.idx,
            text: log.chunk,
            entry: log.entry,
            stop: Boolean(log.stop),
            model: log.model,
            usage: log.usage ? JSON.parse(log.usage) : null,
            stopReason: log.stop_reason ?? "",
            role: log.role ?? "mind-tail",
            genuine: typeof log.genuine === "number" ? log.genuine : -1,
            at: log.at,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (action === "delete" && request.method === "POST") {
      // 削除では受付の枠も返す。消した Run が残り時間ぶん「走行中」と数えられると、
      // 続けて走らせたときに身に覚えのない 429 になる。
      await this.purge("deleted");
      return Response.json({ ok: true, deleted: true });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    // クライアントからの入力は再接続要求だけ。Run に書き込む経路は無い。
    let parsed: { type?: string } = {};
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (parsed.type === "snapshot") socket.send(JSON.stringify(this.snapshot()));
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    // 1005/1006 は「コードなし」を表す予約値で、close() に渡すと
    // InvalidAccessError になる。素直に閉じるだけにする。
    if (code === 1005 || code === 1006 || code < 1000 || code > 4999) socket.close();
    else socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, "socket error");
    } catch {
      // 既に閉じている場合は何もしない
    }
  }
}
