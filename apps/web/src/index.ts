import { authenticate } from "./auth.ts";
import {
  buildAnnotations,
  stopKind,
  extractQuote,
  chunk,
  count,
  JA_TARGET,
  OPENING_SENTENCES,
  TARGET_WORDS,
  MIND_TAIL_PERSONA,
  MIND_TAIL_PROFILE,
  type Lang,
} from "@revise-and-resubmit/core";

import type { Env } from "./env.ts";
import { landingPage, livePage, notFoundPage, resultPage } from "./page.ts";
import { RunObject, GATE_NAME } from "./run-object.ts";
import { RunWorkflow, type ReaderSpec, type RunParams } from "./workflow.ts";
import { GENUINE } from "./judge.ts";
import { READER_MODELS, refuseModel, type Route } from "./models.ts";
import { ingestUrl, IngestError, type Ingested } from "./ingest.ts";

export { RunObject, RunWorkflow };

interface RunState {
  token: string;
  lang: string;
  status: string;
  /** 止まった理由。DO が `status` と一緒に持っている。 */
  reason?: string;
  total: number;
  created_at?: number;
  manifest?: Record<string, unknown>;
  entries: Array<{ idx: number; text: string; entry: string; stop: boolean; stopReason?: string; model?: string; at?: number; role?: string; genuine?: number }>;
  /** 俯瞰型（paper-plot）の指摘と、0件だった場合の理由。 */
  review?: { notes: Array<{ quote: string; comment: string; options?: string[] }>; note?: string };
}

/** 結果ページの見出し。提示済みの最初の断片から取る（全文は載せない）。 */
function resultTitle(entries: RunState["entries"]): string {
  const first = entries[0]?.text ?? "";
  const line = first.split("\n").find((value) => value.trim()) ?? "";
  const title = line.replace(/^#+\s*/, "").trim();
  if (!title) return "レビュー結果";
  return title.length > 70 ? `${title.slice(0, 70)}…` : title;
}

const TOKEN_PATTERN = "[0-9a-f]{32}";
/**
 * 悪用対策の上限（plan.md）。日本語は文字数、英語は語数で数える。
 *
 * 断片数の上限（`MAX_CHUNKS`）と揃っていないと、貼れたのに「断片が多すぎる」で
 * 断られる。日本語は冒頭3文が1文ずつ、以降は目標300字なので、`MAX_CHUNKS` から
 * 逆算して 3 + (chars - 300) / 300 <= MAX_CHUNKS を満たす値にする。
 */

/**
 * 断片数の上限。予算から割り出す。手で決めた数を置くと、役を増やしたときに
 * 決め直すのを忘れる。実際 0002 は「読者を2人にすると超過する」と書いており、
 * その後3人になったが 48 のままだった。
 *
 * Free の外部 subrequest は 50/request。0002 の実測では Run 全体が1つの
 * invocation で走るので、Run 全体で 50 と読む。DO への `stub.fetch` も
 * subrequest に数えられるため、モデル呼び出しだけを数えると足りない。
 *
 * 断片ごと … mind-tail 1 + DO への append 1 + slob-police 1 = 3
 * 固定     … 受付の記帳 2・初期化 1・状態 2・下調べ 2・構造 2 = 9
 *
 * slob-police は不満が無ければ最後まで読むので、3/断片は「よく書けた原稿」で
 * 必ず出る。最悪値ではなく通常値として数えること。
 *
 * この上限を上げる方法は1つ分かっている。`step.sleep` を挟むと Workflow が
 * 中断・再開し、invocation が分かれて予算が数え直される可能性がある。
 * ただし**未検証**で、実機で確かめるまで上限はこの式のままにする。
 */
const SUBREQUEST_BUDGET = 50;
const PER_CHUNK_SUBREQUESTS = 3;
const FIXED_SUBREQUESTS = 9;
const MAX_CHUNKS = Math.floor((SUBREQUEST_BUDGET - FIXED_SUBREQUESTS) / PER_CHUNK_SUBREQUESTS);
/** 冒頭3文ぶんを引いた残りを、目標の大きさで割り切れる長さ。英語も同じ式で出す。 */
const MAX_JA_CHARS = (MAX_CHUNKS - OPENING_SENTENCES) * JA_TARGET;
const MAX_EN_WORDS = (MAX_CHUNKS - OPENING_SENTENCES) * TARGET_WORDS;
/**
 * 受付の上限。字数と断片数は「1 Run の大きさ」の上限で、回数の上限はこちら。
 * 同時利用でも、機械的な連打でも、効くのはここ。
 * 1日の上限は支出の天井（プリペイドのクレジット）から逆算する。
 */
const MAX_ACTIVE_RUNS = 4;
const MAX_DAILY_RUNS = 60;
/** 受付を数えるだけの DO インスタンスの名前は run-object.ts にある（Run 側からも返すため）。 */
const MAX_PACE_MS = 10_000;
/**
 * Workers AI を使うときの既定モデル。Free プランで動くものを選ぶ。
 * 以前の既定 @cf/zai-org/glm-5.3-flash は Free で 5035 を返し、第1断片から失敗した。
 */
const DEFAULT_READER_MODEL = "@cf/openai/gpt-oss-20b";


/**
 * デモの出口。結果ページと、受付が尽きたときの案内に同じものを出す。
 *
 * ここを `export` してはいけない。module 形式の Worker では entry モジュールの
 * 名前付き export がすべて entrypoint（handler object か Durable Object クラス）と
 * 解釈されるため、文字列を export すると workerd が Worker ごと起動に失敗する:
 * `Incorrect type for map entry 'INSTALL_COMMAND': … not of type 'function or ExportedHandler'`。
 * 同じ理由で、この行を消すときは tools/check-entry-exports.mjs も見ること。
 */
const INSTALL_COMMAND =
  "npx skills add laiso/revise-and-resubmit --skill revise-and-resubmit --agent claude-code";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
  });
}

function passthrough(response: Response): Response {
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/** 俯瞰型の指摘にも、逐次と同じ窓を切る（前後60字、両端は省略記号）。 */
function windowAround(source: string, quote: string) {
  const at = source.indexOf(quote);
  if (at < 0) return null;
  const pad = 60;
  const from = Math.max(0, at - pad);
  const to = Math.min(source.length, at + quote.length + pad);
  return {
    before: source.slice(from, at),
    quote,
    after: source.slice(at + quote.length, to),
    headTrimmed: from > 0,
    tailTrimmed: to < source.length,
  };
}

/** capability URL の鍵。推測できないことが唯一の保護なので 128bit 取る。 */
function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 閲覧の鍵を、所有の鍵から一方向に導く。
 *
 * 鍵が1本だと、結果を人に見せた時点で相手に削除の権限まで渡る。かといって
 * 2本目を別に発行して対応表を持つと、置き場所が増える。所有鍵のハッシュを
 * 閲覧鍵にすれば、**閲覧鍵から所有鍵は出ないが、所有鍵からは必ず同じ閲覧鍵が出る**。
 * 実体（DO）は閲覧鍵で引く。所有の証明は「原像を持っていること」そのもの。
 */
async function viewKeyOf(owner: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await authenticate(request, env);
    if (denied) return denied;
    const { pathname } = new URL(request.url);

    if (pathname === "/healthz") return json({ ok: true });
    if (pathname === "/api/limits" && request.method === "GET") return limits(env);
    if (pathname === "/api/ready" && request.method === "GET") return ready(env);
    if (pathname === "/" && request.method === "GET") return html(landingPage());
    if (pathname === "/api/runs" && request.method === "POST") return createRun(request, env);

    /**
     * API はすべて所有鍵。`/state` も WebSocket も、提示済みの断片の**本文**を
     * そのまま返す経路なので、閲覧鍵で引けてはいけない。閲覧鍵が開けるのは
     * `/v/{閲覧鍵}/result` だけ、つまり窓を切った抜粋だけ。
     */
    const state = pathname.match(new RegExp(`^/api/runs/(${TOKEN_PATTERN})/state$`));
    if (state) {
      const view = await viewKeyOf(state[1]);
      return passthrough(await env.RUN.get(env.RUN.idFromName(view)).fetch("https://run.internal/state"));
    }

    const remove = pathname.match(new RegExp(`^/api/runs/(${TOKEN_PATTERN})/delete$`));
    if (remove) return deleteRun(remove[1], request, env);

    const socket = pathname.match(new RegExp(`^/api/runs/(${TOKEN_PATTERN})/ws$`));
    if (socket) {
      const view = await viewKeyOf(socket[1]);
      return env.RUN.get(env.RUN.idFromName(view)).fetch("https://run.internal/ws", request);
    }

    // /r/{所有鍵}/result は本人の画面（削除と共有リンクが出る）。
    // /v/{閲覧鍵}/result は見せるための画面（削除は出ない）。中身は同じ。
    const result = pathname.match(new RegExp(`^/(r|v)/(${TOKEN_PATTERN})/result/?$`));
    if (result) {
      const owner = result[1] === "r" ? result[2] : undefined;
      const token = owner ? await viewKeyOf(owner) : result[2];
      const response = await env.RUN.get(env.RUN.idFromName(token)).fetch("https://run.internal/state");
      if (!response.ok) {
        await response.body?.cancel();
        return html(notFoundPage(), 404);
      }
      const state = (await response.json()) as RunState;
      const entries = (state.entries ?? []) as RunState["entries"];
      // 俯瞰型の指摘も同じ関数に渡す。窓と再現量の上限を1箇所で効かせるため。
      // 役ごとに分ける。mind-tail は凝縮を通し、slob-police は止まった1件だけ。
      // 判定役（Jev）の値を、ここで表示の是非に落とす。閾値はアプリ側の判断なので
      // core には置かない。-1（判定なし・呼べなかった）は undefined にして
      // 自己申告の正規表現に戻す。判定は間違いうるので、元のログは raw に残る。
      const reading = entries
        .filter((entry) => (entry.role ?? "mind-tail") === "mind-tail")
        .map((entry) => ({
          ...entry,
          revised:
            typeof entry.genuine === "number" && entry.genuine >= 0
              ? entry.genuine >= GENUINE
              : undefined,
        }));
      const slob = entries.filter((entry) => entry.role === "slob-police");
      const annotations = buildAnnotations(reading, "mind-tail", [
        ...slob.map((entry) => ({
          quote: (entry.entry.match(/引用：(.*)/)?.[1] ?? "").trim(),
          comment: entry.entry.split("\n")[0],
          role: "slob-police",
          // 離脱した場所がある。全体についての指摘ではない。
          covers: [entry.idx],
          // 呼べなかった記録も stop: true で残る。読者が止まったことにしない。
          kind: stopKind(entry.stopReason),
        })),
        ...(state.review?.notes ?? []),
      ]);
      // 使ったモデルを画面に出す。安いモデルの結果かどうかを、あとから判断できるように。
      // インストール導線は失敗処理ではなく本来の出口（docs/implementation-plan.md 4-3）。
      const model = entries.find((entry) => entry.model)?.model ?? "";
      return html(
        resultPage(annotations, {
          view: token,
          owner,
          status: state.status,
          reason: state.reason,
          total: state.total,
          title:
            typeof state.manifest?.source_title === "string" && state.manifest.source_title
              ? state.manifest.source_title
              : resultTitle(entries),
          model,
          createdAt: state.created_at,
          install: INSTALL_COMMAND,
          sourceUrl: typeof state.manifest?.source_url === "string" ? state.manifest.source_url : undefined,
          knownTerms: (state.manifest?.presearch as { terms?: Array<{ term: string; gloss: string }> } | undefined)?.terms,
          unknownTerms: (state.manifest?.presearch as { unresolved?: string[] } | undefined)?.unresolved,
          truncated: state.manifest?.truncated as { paragraphs: number; total: number } | undefined,
        }),
      );
    }

    // ライブ画面は本人のもの。中の WebSocket は実体（閲覧鍵）を引く。
    const page = pathname.match(new RegExp(`^/r/(${TOKEN_PATTERN})/?$`));
    if (page) {
      const view = await viewKeyOf(page[1]);
      const alive = await env.RUN.get(env.RUN.idFromName(view)).fetch("https://run.internal/state");
      await alive.body?.cancel();
      if (!alive.ok) return html(notFoundPage(), 404);
      return html(livePage(page[1]));
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

/**
 * いま走っている本数と、今日受けた件数。受付が 429 になったときの切り分けと、
 * 「終わった Run が枠を返しているか」の確認に使う（`/api/limits`）。
 */
async function limits(env: Env): Promise<Response> {
  const gate = await env.RUN.get(env.RUN.idFromName(GATE_NAME)).fetch("https://run.internal/gate-peek");
  if (!gate.ok) {
    await gate.body?.cancel();
    return json({ error: "limits unavailable" }, 503);
  }
  const detail = (await gate.json()) as { active: number; today: number };
  return json({
    ...detail,
    maxActive: Number(env.MAX_ACTIVE_RUNS ?? MAX_ACTIVE_RUNS),
    maxDaily: Number(env.MAX_DAILY_RUNS ?? MAX_DAILY_RUNS),
  });
}

/**
 * 読者の経路とモデルを決め、使ってよい一覧に照らす。
 *
 * 入稿（`createRun`）と、入稿前の可否確認（`/api/ready`）の両方から呼ぶ。同じ関数を
 * 通さないと、「トップでは受け付けると言っておいて、貼ったあとで断る」が起きる。
 */
type Resolved =
  | { ok: true; reader: ReaderSpec; modelLabel: string }
  | { ok: false; status: number; payload: Record<string, unknown> };

function resolveReader(env: Env, body: Record<string, unknown>, scripted: (string | null)[]): Resolved {
  const requested =
    body.reader === "gateway" || body.reader === "mock" || body.reader === "workers-ai" || body.reader === "compat"
      ? body.reader
      : null;
  // 台本が渡されたら常にモック。明示指定が次。既定は Gateway（読者の質と速度を優先する
  // ため。docs/implementation-plan.md）。AI binding があるだけで Workers AI に落とさない。
  const mode: "mock" | "gateway" | "workers-ai" | "compat" =
    scripted.length > 0 || requested === "mock"
      ? "mock"
      : requested === "compat"
        ? "compat"
        : requested === "workers-ai"
          ? "workers-ai"
        : requested === "gateway"
          ? "gateway"
          : env.READER_KIND === "workers-ai" || env.READER_KIND === "gateway" || env.READER_KIND === "mock" || env.READER_KIND === "compat"
            ? env.READER_KIND
            : env.COMPAT_BASE_URL && env.AI_GATEWAY_TOKEN
              ? "compat"
              : env.ANTHROPIC_BASE_URL
              ? "gateway"
              : env.AI
                ? "workers-ai"
                : "mock";

  let reader: ReaderSpec;
  if (mode === "compat") {
    if (!env.COMPAT_BASE_URL || !env.AI_GATEWAY_TOKEN) {
      return { ok: false, status: 400, payload: { error: "compat reader is not configured", need: ["COMPAT_BASE_URL", "AI_GATEWAY_TOKEN"] } };
    }
    reader = {
      kind: "compat",
      persona: env.READER_PERSONA ?? MIND_TAIL_PERSONA,
      config: {
        baseUrl: env.COMPAT_BASE_URL,
        model:
          typeof body.readerModel === "string" && body.readerModel
            ? body.readerModel
            : (env.COMPAT_MODEL ?? "google-ai-studio/gemini-3.8-flash"),
        aigToken: env.AI_GATEWAY_TOKEN,
        maxTokens: 4096,
      },
    };
  } else if (mode === "workers-ai") {
    const model =
      typeof body.readerModel === "string" && body.readerModel
        ? body.readerModel
        : (env.READER_MODEL ?? DEFAULT_READER_MODEL);
    reader = {
      kind: "workers-ai",
      persona: env.READER_PERSONA ?? MIND_TAIL_PERSONA,
      model,
      maxTokens: 4096,
    };
  } else if (mode === "gateway") {
    // 既定値を置かない。読者のモデルは測って決めたもので、経路の都合で
    // 勝手に決まってよいものではない（docs/implementation-plan.md）。
    if (!env.ANTHROPIC_MODEL) {
      return {
        ok: false,
        status: 400,
        payload: {
          error: "reader model is not configured",
          need: ["ANTHROPIC_MODEL"],
          hint: "読者のモデルは既定値では決めません。compat 経路なら COMPAT_BASE_URL と COMPAT_MODEL を設定してください。",
        },
      };
    }
    reader = {
      kind: "gateway",
      persona: env.READER_PERSONA ?? MIND_TAIL_PERSONA,
      config: {
        baseUrl: env.ANTHROPIC_BASE_URL as string,
        model: env.ANTHROPIC_MODEL,
        apiKey: env.ANTHROPIC_API_KEY,
        aigToken: env.AI_GATEWAY_TOKEN,
        beta: env.READER_BETA ?? "server-side-fallback-2026-07-01",
      },
      fallbackModel: env.READER_FALLBACK_MODEL,
    };
  } else {
    reader = { kind: "mock", entries: scripted, model: scripted.length ? "mock:replay" : "mock" };
  }
  const modelLabel =
    reader.kind === "mock"
      ? reader.model
      : reader.kind === "workers-ai"
        ? `workers-ai:${reader.model}`
        : reader.kind === "compat"
          ? reader.config.model
          : `gateway:${reader.config.model}`;

  /**
   * 使ってよいモデルの一覧に照らす。差し替え先（拒否されたときの回り先）も同じ扱い。
   * そこを見ないと、「普段は安いが、拒否されたときだけ黙って高いほうへ行く」経路が残る。
   */
  const candidates: { id: string; route?: Route }[] =
    reader.kind === "mock"
      ? []
      : [
          // 実際に使うモデルは、綴りがこの経路のものかまで見る。一覧に載っている
          // だけでは、gateway に compat 形式の ID を置いた構成が素通りして、
          // 読書が1断片目で死ぬ。
          { id: reader.kind === "workers-ai" ? reader.model : reader.config.model, route: reader.kind },
          // 差し替え先は一覧だけ見る（費用の歯止め）。綴りの不一致は拒否が起きた
          // ときにしか表に出ず、そのときは設定の誤りとして落ちればよい。
          ...(reader.kind === "gateway" && reader.fallbackModel ? [{ id: reader.fallbackModel }] : []),
        ];
  for (const candidate of candidates) {
    const refused = refuseModel(candidate.id, "reader", candidate.route);
    if (refused)
      return { ok: false, status: 400, payload: { error: refused, model: candidate.id, allowed: READER_MODELS.map((m) => m.id) } };
  }
  return { ok: true, reader, modelLabel };
}

/**
 * 入稿できる状態かを、貼る前に答える。
 *
 * 読者のモデルが一覧に無い・設定が足りない、というのは**運用者の失敗**であって、
 * 書き手の失敗ではない。それを入稿後に出すと、8000字貼った人が、自分では選んで
 * いないモデル名で断られる。だから貼る前に聞く。書き手には理由を見せず、
 * 運用者向けの詳細は `detail` に分けて入れる。
 */
async function ready(env: Env): Promise<Response> {
  const resolved = resolveReader(env, {}, []);
  if (!resolved.ok) {
    return json({
      ready: false,
      // 書き手に出す文言。モデル名は出さない。
      message: "いまこのサーバーは原稿を読めません。運用者の設定が済んでいません。",
      detail: resolved.payload,
    });
  }

  const gate = await env.RUN.get(env.RUN.idFromName(GATE_NAME)).fetch("https://run.internal/gate-peek");
  if (!gate.ok) {
    await gate.body?.cancel();
    return json({ ready: false, message: "いま受付の状態が確認できません。少し待ってからお試しください。" });
  }
  const detail = (await gate.json()) as { active: number; today: number };
  const maxActive = Number(env.MAX_ACTIVE_RUNS ?? MAX_ACTIVE_RUNS);
  const maxDaily = Number(env.MAX_DAILY_RUNS ?? MAX_DAILY_RUNS);
  if (detail.active >= maxActive) {
    return json({
      ready: false,
      message: `いま${detail.active}本が読書中で、空きがありません（同時に${maxActive}本まで）。終わるまでお待ちください。`,
      ...detail,
      maxActive,
      maxDaily,
    });
  }
  if (detail.today >= maxDaily) {
    return json({
      ready: false,
      message: `今日の受付分（${maxDaily}本）が終わりました。日付が変わるとまた受け付けます。`,
      ...detail,
      maxActive,
      maxDaily,
    });
  }
  return json({ ready: true, model: resolved.modelLabel, ...detail, maxActive, maxDaily });
}

async function createRun(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const lang: Lang = body.lang === "en" ? "en" : "ja";
  const limit = lang === "ja" ? MAX_JA_CHARS : MAX_EN_WORDS;

  // URL 入稿。受付の枠を取る前に済ませる（モデルを呼ばないので安く、
  // 取り込みに失敗した Run が枠を1つ食ったまま残らない）。
  let ingested: Ingested | null = null;
  if (typeof body.url === "string" && body.url.trim()) {
    try {
      ingested = await ingestUrl(body.url.trim(), limit, (value) => count(value, lang));
    } catch (error) {
      if (error instanceof IngestError) return json({ error: error.message, url: body.url }, error.status);
      return json({ error: "記事を取得できませんでした", url: body.url }, 502);
    }
  }

  const manuscript = ingested ? ingested.text : typeof body.manuscript === "string" ? body.manuscript : "";
  if (!manuscript.trim()) return json({ error: "manuscript or url is required" }, 400);

  const length = count(manuscript, lang);
  if (length > limit) {
    return json({ error: "manuscript is too long", lang, limit, actual: length }, 413);
  }

  const chunks = chunk(manuscript, lang);
  if (!chunks.length) return json({ error: "no chunks" }, 400);
  if (chunks.length > MAX_CHUNKS) {
    return json({ error: "too many chunks", limit: MAX_CHUNKS, actual: chunks.length }, 413);
  }

  // モック台本。`null` はその断片で読者が読むのをやめたことを表す。
  const scripted = Array.isArray(body.mockEntries)
    ? body.mockEntries.map((value) => (value === null ? null : String(value)))
    : [];
  const resolved = resolveReader(env, body, scripted);
  if (!resolved.ok) return json(resolved.payload, resolved.status);
  const { reader, modelLabel } = resolved;

  const paceMs = Number.isFinite(body.paceMs)
    ? Math.min(MAX_PACE_MS, Math.max(0, Number(body.paceMs)))
    : 0;

  const owner = newToken();
  // 実体は閲覧鍵で引く。所有鍵は URL にしか現れず、どこにも保存しない。
  const token = await viewKeyOf(owner);

  // 受付の可否。混んでいるなら、20分待たせて空振りするより断るほうがよい。
  const gate = await env.RUN.get(env.RUN.idFromName(GATE_NAME)).fetch("https://run.internal/gate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      maxActive: Number(env.MAX_ACTIVE_RUNS ?? MAX_ACTIVE_RUNS),
      maxDaily: Number(env.MAX_DAILY_RUNS ?? MAX_DAILY_RUNS),
    }),
  });
  if (!gate.ok) {
    // json() で読み切っているので cancel は呼ばない（使用済みの body を
    // cancel すると例外になり、応答が返らなくなる）。
    const detail = (await gate.json()) as { reason?: string; active?: number; today?: number };
    return json(
      detail.reason === "daily"
        ? {
            error: "daily limit reached",
            message: "本日分の受付は終了しました。手元のスキルなら制限なく試せます。",
            install: INSTALL_COMMAND,
          }
        : {
            error: "busy",
            message: "いま混んでいます。少し時間を置いてからお試しください。",
            active: detail.active,
          },
      429,
    );
  }
  await gate.body?.cancel();

  const stub = env.RUN.get(env.RUN.idFromName(token));
  const manifest = {
    skill: "revise-and-resubmit",
    run: token,
    lang,
    chunks: chunks.length,
    model: modelLabel,
    reader: reader.kind,
    profile: { "mind-tail": `${MIND_TAIL_PROFILE.temperament} / ${MIND_TAIL_PROFILE.display}` },
    pace_ms: paceMs,
    created_at: new Date().toISOString(),
    orchestrator_knows_source: false,
    author_suspicions_supplied: false,
    prior_feedback_hidden: true,
    // URL 入稿のときだけ。出所と、読者に渡らなかったものを残す。
    ...(ingested
      ? {
          source_url: ingested.sourceUrl,
          source_title: ingested.title,
          extraction_dropped: ingested.dropped,
          ...(ingested.truncated ? { truncated: ingested.truncated } : {}),
        }
      : {}),
    ...(body.manifest && typeof body.manifest === "object" ? (body.manifest as object) : {}),
  };

  const init = await stub.fetch("https://run.internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, source: manuscript, chunks, lang, manifest }),
  });
  if (!init.ok) return passthrough(init);
  // body を読まずに捨てると、workerd がこのリクエストを「応答しない」ものとして
  // 報告する。中身は要らないので明示的に閉じる。
  await init.body?.cancel();

  const params: RunParams = { token, chunks, lang, paceMs, reader };
  await env.RUN_WORKFLOW.create({ id: `run-${token}`, params });

  return json(
    {
      token: owner,
      url: `/r/${owner}`,
      // 見せるためのリンク。削除はできない。
      shareUrl: `/v/${token}/result`,
      chunks: chunks.length,
      lang,
      model: modelLabel,
      reader: reader.kind,
      ...(ingested
        ? { sourceUrl: ingested.sourceUrl, title: ingested.title, dropped: ingested.dropped, truncated: ingested.truncated }
        : {}),
    },
    201,
  );
}

/**
 * 削除は所有鍵でしか通らない。閲覧鍵を渡された場合は、そこから所有鍵は出ないので
 * 実体に当たらず 404 になる（「鍵が違う」と教えると、鍵の種類が漏れる）。
 */
async function deleteRun(owner: string, request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const view = await viewKeyOf(owner);
  const stub = env.RUN.get(env.RUN.idFromName(view));
  // 空の DO に delete を撃つと deleteAll() が成功して `{deleted:true}` を返す。
  // 存在しない Run を「消した」と答えると、鍵の当たり外れが分かってしまう。
  const alive = await stub.fetch("https://run.internal/state");
  const found = alive.ok;
  await alive.body?.cancel();
  if (!found) return json({ error: "not found" }, 404);
  try {
    await (await env.RUN_WORKFLOW.get(`run-${view}`)).terminate();
  } catch {
    // 既に終わっている Run の削除は普通の操作なので失敗にしない。
  }
  return passthrough(await stub.fetch("https://run.internal/delete", { method: "POST" }));
}
