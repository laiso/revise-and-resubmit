import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  buildReaderMessages,
  buildReaderSystem,
  buildSlobSystem,
  buildStructureSystem,
  buildStructureUserText,
  formatSlobNote,
  parseSlobNote,
  formatNote,
  parseReaderNote,
  parseStructureNotes,
  type Lang,
  type ReaderNote,
} from "@revise-and-resubmit/core";

import type { Env } from "./env.ts";
import { mockSlobReply, mockStructureReply } from "./mock-reader.ts";
import { callReader, type ReaderConfig } from "./reader-client.ts";
import { GATE_NAME } from "./run-object.ts";
import { callWorkersAi } from "./workers-ai-reader.ts";
import { callCompat, type CompatConfig } from "./reader-compat.ts";
import { ReaderConfigError } from "./reader-errors.ts";
import { judgeRevision } from "./judge.ts";
import { knowledgeBlock, presearch, type Presearch } from "./presearch.ts";

/**
 * モック台本（アーカイブの再生）か、Gateway 経由の実モデルか。
 * どちらも「1 chunk → 1 応答」なので、差し替えで作り直しが出ない。
 */
export type ReaderSpec =
  | { kind: "mock"; entries: Array<string | null>; model: string }
  | { kind: "gateway"; persona: string; config: ReaderConfig; fallbackModel?: string }
  | { kind: "workers-ai"; persona: string; model: string; maxTokens: number }
  // AI Gateway の統一形。provider/model の文字列でモデルを差し替える。
  | { kind: "compat"; persona: string; config: CompatConfig };

/**
 * 段取りと耐久性を持つ側。1 step = 1 chunk で、step の最後に DO へ1回書く。
 * 読者の停止申告でループを打ち切る。サーバーが断片数を数えて打ち切るのではない
 * （決定記録 0002）。
 */
export interface RunParams {
  token: string;
  chunks: string[];
  lang: Lang;
  paceMs: number;
  reader: ReaderSpec;
}

interface ChunkOutcome {
  stop: boolean;
  gone: boolean;
  entry: string;
  model: string;
  structured: boolean;
  note: ReaderNote;
  /** 読者が正常に言い終えたか（end_turn）、途中で切れたか（max_tokens）、拒否か。 */
  stopReason: string;
  /** 設定の誤りで止まった場合。status を errored にする。 */
  configError?: boolean;
  /** 「修正」が本物の訂正らしいか（0〜1）。判定しなかった／呼べなかったときは -1。 */
  genuine: number;
}

/**
 * 1断片あたりの上限。超えたら Run を errored にする。
 * これが無いと、同時実行やコードの再読み込みで中断された Run が `running` のまま
 * 0件で残り、「遅い」と「壊れた」が区別できない（実際に16分そのままの Run が出た）。
 */
const CHUNK_TIMEOUT_MS = 180_000;

function withTimeout<T>(index: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    work.finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`chunk ${index + 1} timed out after ${CHUNK_TIMEOUT_MS}ms`)),
        CHUNK_TIMEOUT_MS,
      );
    }),
  ]);
}

export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { token, chunks, lang, reader, paceMs } = event.payload;
    const stub = this.env.RUN.get(this.env.RUN.idFromName(token));

    // Gateway 経由（Anthropic）は refusal のときに一度だけフォールバックモデルへ回す。
    const callGateway = async (
      reader: Extract<ReaderSpec, { kind: "gateway" }>,
      prompt: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> },
    ) => {
      let reply = await callReader(reader.config, prompt);
      if (reply.stopReason === "refusal" && reader.fallbackModel) {
        reply = await callReader({ ...reader.config, model: reader.fallbackModel }, prompt);
      }
      return reply;
    };

    const write = async (action: string, body: unknown): Promise<boolean> => {
      const response = await stub.fetch(`https://run.internal/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const status = response.status;
      // body を読まずに捨てると workerd が「応答しないリクエスト」として報告する。
      await response.body?.cancel();
      // 410 は削除と競合した場合。Run が無いのだから書き続けない。
      if (status === 410 || status === 409) return false;
      if (!response.ok) throw new Error(`${action} failed: ${status}`);
      return true;
    };

    /**
     * 受付の枠を返す。正常終了・エラー終了のどちらでも呼ぶ。異常終了で数が漏れる
     * 場合に備えて、`__limits__` 側にも時間切れ（ACTIVE_WINDOW_MS）がある。
     * ここが失敗しても Run の結果は変わらないので、投げない。
     */
    const release = async () => {
      try {
        const limits = this.env.RUN.get(this.env.RUN.idFromName(GATE_NAME));
        const response = await limits.fetch("https://run.internal/gate-release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        await response.body?.cancel();
      } catch {
        // 枠は時間切れで戻る。
      }
    };

    await write("status", { status: "running" });

    /**
     * 読ませる前の下調べ。読者ではなく進行役が、一度だけ調べる（決定記録 0003）。
     * ここで固定しないと、モデルが知らない固有名詞が「説明が足りない」という
     * 原稿への指摘として出てしまう（4モデル全部が同じ語で詰まった実測がある）。
     * 失敗しても読書は成立するので、理由を残して先へ進む。
     */
    let knowledge = "";
    if (reader.kind !== "mock" && this.env.COMPAT_BASE_URL && this.env.AI_GATEWAY_TOKEN) {
      const found = await step.do<Presearch>("presearch", async () =>
        presearch(
          { baseUrl: this.env.COMPAT_BASE_URL as string, aigToken: this.env.AI_GATEWAY_TOKEN as string },
          chunks.join(""),
        ),
      );
      knowledge = knowledgeBlock(found.terms);
      await write("presearch", found).catch(() => undefined);
    }

    // 読者自身のこれまでのメモ。step が再実行されても同じ並びが再構築される。
    const notes: ReaderNote[] = [];
    let served = 0;
    let stopped = false;
    let gone = false;
    let configError = false;
    let unstructured = 0;
    let modelSwitches = 0;

    try {
    for (let i = 0; i < chunks.length; i++) {
      const outcome = await step.do<ChunkOutcome>(`chunk-${i + 1}`, async () => {
        let entry: string;
        let stop: boolean;
        let model: string;
        let structured: boolean;
        let note: ReaderNote;
        let usage: unknown = null;
        let replyStopReason = "";

        if (reader.kind === "mock") {
          const scripted =
            i < reader.entries.length ? reader.entries[i] : `（モック）第${i + 1}断片を読みました。`;
          if (scripted === null) {
            // 読者の停止申告。ここで打ち切るのはサーバーの判断ではない。
            stop = true;
            structured = false;
            entry = "（読者がここで読むのをやめた）";
          } else {
            stop = false;
            structured = true;
            entry = scripted;
          }
          model = reader.model;
          note = parseReaderNote(entry, i);
        } else {
          const messages = buildReaderMessages([
            ...notes.map((note, index) => ({
              index,
              total: chunks.length,
              chunk: chunks[index],
              lang,
              note,
            })),
            { index: i, total: chunks.length, chunk: chunks[i], lang },
          ]);
          const prompt = {
            // 既知は mind-tail にだけ渡す。詰まったのはこの役で、
            // slob-police（言い回し）と paper-plot（構成）には関係がない。
            system: buildReaderSystem(reader.persona, knowledge),
            // 過去の断片（user）と自分の記録（assistant）を交互に並べ、今回の断片を最後に置く。
            messages,
          };
          const ask = () =>
            withTimeout(
              i,
              reader.kind === "workers-ai"
                ? callWorkersAi(this.env.AI, {
                    model: reader.model,
                    system: prompt.system,
                    messages,
                    maxTokens: reader.maxTokens,
                  })
                : reader.kind === "compat"
                  ? callCompat(reader.config, prompt)
                  : callGateway(reader, prompt),
            );

          let reply;
          try {
            reply = await ask();
            // 空の応答は起こる（Gemini で実測 1/8、Qwen で 1/17）。1度だけ引き直す。
            // 2度続けて空なら、そのモデルではこの断片を読めていないと見なす。
            if (!reply.text || !reply.text.trim()) reply = await ask();
          } catch (error) {
            // 設定の誤りはリトライしない。理由を1件の記録として残して Run を止める。
            if (error instanceof ReaderConfigError) {
              const reason = error.summary;
              const failure = `（読者を呼べませんでした: ${reason}）`;
              const failureNote = parseReaderNote(failure, i);
              await write("append", { idx: i, text: chunks[i], entry: failure, stop: true, model: "none", usage: null, stopReason: "config_error" });
              return { stop: true, gone: false, entry: failure, model: "none", structured: false, note: failureNote, stopReason: "config_error", configError: true, genuine: -1 };
            }
            throw error;
          }
          usage = reply.usage;
          // 空の応答は「読んだ結果」ではない。弱いモデルが黙って無意味なログを
          // 残すのを防ぐため、結果として使えないことを記録して止める。
          if (!reply.text || !reply.text.trim()) {
            const empty = `（読者から空の応答。モデル: ${reply.model}。この Run は結果として使えない）`;
            const emptyNote = parseReaderNote(empty, i);
            // 札は "empty" で固定する。空の応答でも API は end_turn を返すので、
            // それを載せると結果ページで読者の離脱と区別できなくなる。
            await write("append", { idx: i, text: chunks[i], entry: empty, stop: true, model: reply.model, usage, stopReason: "empty" });
            return { stop: true, gone: false, entry: empty, model: reply.model, structured: false, note: emptyNote, stopReason: "empty", configError: true, genuine: -1 };
          }
          if (reply.stopReason === "refusal") {
            stop = true;
            structured = false;
            entry = `（読者が回答を拒否された。分類: ${reply.refusalCategory ?? "unknown"}）`;
            model = reply.model;
            note = parseReaderNote(entry, i);
          } else {
            note = parseReaderNote(reply.text, i);
            // 形式は守っているが中身が空、という応答もある（弱いモデルで起きる）。
            // 「何も言っていない読解」は読解ではないので、結果として使えないと記録する。
            const silent =
              (!note.understanding || note.understanding === "なし") &&
              note.evidence === "なし" &&
              note.revision === "なし";
            if (silent) {
              const unreadable = `（読者から中身の無い応答。モデル: ${reply.model}。この Run は結果として使えない）`;
              const unreadableNote = parseReaderNote(unreadable, i);
              // ここも同じ。中身が無い応答は、形式上は正常終了で返ってくる。
              await write("append", { idx: i, text: chunks[i], entry: unreadable, stop: true, model: reply.model, usage, stopReason: "silent" });
              return { stop: true, gone: false, entry: unreadable, model: reply.model, structured: false, note: unreadableNote, stopReason: "silent", configError: true, genuine: -1 };
            }
            // 途中で切れた応答は、形が整っていても読解ではない。黙って正常な
            // ログとして積むのが最も避けたい失敗なので、ここで止める。
            if (reply.stopReason === "max_tokens" || reply.stopReason === "length") {
              const cut = `（読者の応答が途中で切れた。モデル: ${reply.model}、stop_reason: ${reply.stopReason}。この Run は結果として使えない）`;
              const cutNote = parseReaderNote(cut, i);
              await write("append", { idx: i, text: chunks[i], entry: cut, stop: true, model: reply.model, usage, stopReason: reply.stopReason });
              return { stop: true, gone: false, entry: cut, model: reply.model, structured: false, note: cutNote, stopReason: reply.stopReason, configError: true, genuine: -1 };
            }
            stop = note.stop;
            structured = note.structured;
            entry = formatNote(note);
            model = reply.model;
          }
          replyStopReason = reply.stopReason;
        }

        // 「修正」の自己申告を、そのまま画面の強調に使わない。実測では大半が
        // 「話が先に進んだだけ」で、Sonnet の zenn-01 では8件中1件しか訂正でなかった。
        // モックでは判定しない（外に出さない）。呼べなければ -1 のまま、正規表現に戻す。
        let genuine = -1;
        if (
          reader.kind !== "mock" &&
          note.revision &&
          note.revision !== "なし" &&
          this.env.COMPAT_BASE_URL &&
          this.env.AI_GATEWAY_TOKEN
        ) {
          genuine = await judgeRevision(
            { baseUrl: this.env.COMPAT_BASE_URL, aigToken: this.env.AI_GATEWAY_TOKEN },
            note.revision,
          );
        }
        const written = await write("append", { idx: i, text: chunks[i], entry, stop, model, usage, stopReason: replyStopReason, genuine });
        return { stop, gone: !written, entry, model, structured, note, stopReason: replyStopReason, genuine };
      });

      notes.push(outcome.note);
      if (!outcome.structured) unstructured += 1;
      if (reader.kind === "gateway" && outcome.model !== reader.config.model) modelSwitches += 1;

      if (outcome.gone) {
        gone = true;
        break;
      }
      if (outcome.configError) {
        configError = true;
        stopped = true;
        break;
      }
      if (outcome.stop) {
        // 最後の断片で「読み終えた」だけなら離脱ではない。正常終了として数える。
        if (i === chunks.length - 1) {
          served += 1;
          break;
        }
        stopped = true;
        break;
      }

      served++;
      if (paceMs > 0 && i + 1 < chunks.length) {
        await step.sleep(`pace-${i + 1}`, paceMs);
      }
    }
    } catch (error) {
      // 例外で終わった Run が `running` のまま残ると、「遅い」と「壊れた」が
      // 区別できない。理由を残して errored にしてから投げ直す。
      const reason = error instanceof Error ? error.message : String(error);
      await write("status", { status: "errored", reason }).catch(() => undefined);
      await release();
      throw error;
    }

    // slob-police。mind-tail とは独立に、同じ断片を最初から読む。
    // 並行に走らせたいが、step.do の並列は挙動が読めないので直列にする。
    // 一度の不満で止まる役なので、実測では数断片で終わる（費用も時間も小さい）。
    let slobStop = -1;
    if (!gone && !configError) {
      for (let i = 0; i < chunks.length; i++) {
        const outcome = await step.do<{ stop: boolean; gone: boolean }>(`slob-${i + 1}`, async () => {
          const prompt = {
            system: buildSlobSystem(),
            messages: [
              {
                role: "user" as const,
                // slob-police には理解の記録を求めない。渡すのは断片だけ。
                content: `次の断片です。\n\n${chunks[i]}`,
              },
            ],
          };
          let reply;
          try {
            reply =
              reader.kind === "mock"
                ? { text: mockSlobReply(chunks[i], i, chunks.length), model: reader.model, usage: null, stopReason: "end_turn" }
                : reader.kind === "workers-ai"
                ? await withTimeout(i, callWorkersAi(this.env.AI, {
                    model: reader.model,
                    system: prompt.system,
                    messages: prompt.messages,
                    maxTokens: reader.maxTokens,
                  }))
                : reader.kind === "compat"
                  ? await withTimeout(i, callCompat(reader.config, prompt))
                  : await withTimeout(i, callGateway(reader, prompt));
          } catch (error) {
            // 失敗と「不満なく通過した」は別物。区別できないと、静かな成功に見える。
            const reason = error instanceof Error ? error.message : String(error);
            await write("append", {
              idx: i,
              text: chunks[i],
              entry: `（slob-police を呼べませんでした: ${reason.slice(0, 160)}）`,
              stop: true,
              model: "none",
              usage: null,
              stopReason: "reader_error",
              role: "slob-police",
            }).catch(() => undefined);
            return { stop: true, gone: false };
          }
          const note = parseSlobNote(reply.text, i);
          if (!note.stop) return { stop: false, gone: false };
          const written = await write("append", {
            idx: i,
            text: chunks[i],
            entry: formatSlobNote(note),
            stop: true,
            model: reply.model,
            usage: reply.usage,
            stopReason: reply.stopReason,
            role: "slob-police",
          });
          return { stop: true, gone: !written };
        });
        if (outcome.gone) { gone = true; break; }
        if (outcome.stop) { slobStop = i; break; }
      }
    }

    // 俯瞰型（paper-plot）。読者の記録が確定してから、全体を見る。
    // 逐次読みをもう一往復しないので、外部呼び出しは数回で済む。
    let structureNotes = 0;
    if (!gone && !configError && notes.length) {
      structureNotes = await step.do<number>("structure", async () => {
        const served = chunks.slice(0, notes.length).join("");
        const log = notes
          .map((note, index) => `【${index + 1}】${formatNote(note)}`)
          .join("\n\n");
        const prompt = {
          system: buildStructureSystem(),
          messages: [{ role: "user" as const, content: buildStructureUserText(served, log) }],
        };
        try {
          const reply = await withTimeout(
            chunks.length,
            reader.kind === "mock"
              ? Promise.resolve({ text: mockStructureReply(served), model: reader.model, usage: null, stopReason: "end_turn" })
              : reader.kind === "workers-ai"
              ? callWorkersAi(this.env.AI, {
                  model: reader.model,
                  system: prompt.system,
                  messages: prompt.messages,
                  maxTokens: reader.maxTokens,
                })
              : reader.kind === "compat"
                ? callCompat(reader.config, prompt)
                : callGateway(reader, prompt),
          );
          const found = parseStructureNotes(reply.text, served);
          // 0件が「懸念なし」なのか「返答を読めなかった」のかを残す。
          if (!found.length && reply.text.trim()) {
            await write("review", {
              notes: [],
              note: `構造レビューの返答を指摘として読めませんでした（${reply.text.length}字）。`,
            });
            return 0;
          }
          await write("review", { notes: found });
          return found.length;
        } catch (error) {
          // 構造レビューが取れなくても、読書の結果は成立する。ただし理由は残す。
          const reason = error instanceof Error ? error.message : String(error);
          await write("review", { notes: [], note: `構造レビューを呼べませんでした: ${reason.slice(0, 160)}` }).catch(
            () => undefined,
          );
          return 0;
        }
      });
    }

    const status = gone ? "deleted" : configError ? "errored" : stopped ? "stopped" : "complete";
    if (!gone) await write("status", { status });
    await release();

    // 完了後の結果は instance.status() から読める（決定記録 0002）。
    // unstructured と modelSwitches は「その Run を実験結果として数えてよいか」の材料。
    return { status, served, stopped, chunks: chunks.length, token, unstructured, modelSwitches, configError, structureNotes, slobStop };
  }
}
