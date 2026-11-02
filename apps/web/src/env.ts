export interface Env {
  PREVIEW_USER?: string;
  PREVIEW_PASSWORD?: string;
  RUN: DurableObjectNamespace;
  /** Workflow は workers-types のグローバル型（cloudflare:workers からは export されない）。 */
  RUN_WORKFLOW: Workflow;
  /** Workers AI の binding。あれば `READER_MODEL`（既定 @cf/zai-org/glm-5.3-flash）で読者を動かす。 */
  AI?: Ai;
  READER_MODEL?: string;
  /** 統一形のベース（https://gateway.ai.cloudflare.com/v1/{account}/{gateway}）。 */
  COMPAT_BASE_URL?: string;
  /** 例: google-ai-studio/gemini-3.8-flash */
  COMPAT_MODEL?: string;
  /** 受付の上限。既定は index.ts の MAX_ACTIVE_RUNS / MAX_DAILY_RUNS。 */
  MAX_ACTIVE_RUNS?: string;
  MAX_DAILY_RUNS?: string;
  /**
   * 進捗が途絶えたと見なすまでのミリ秒。既定は run-object.ts の STALL_MS（7分）。
   * 試験で中断を再現するときだけ、秒単位に落として使う。
   */
  STALL_MS?: string;
  /** 既定の読者経路を固定する（workers-ai | gateway | mock）。未設定なら binding の有無で決める。 */
  READER_KIND?: string;

  /**
   * 読者を実モデルで動かすときの設定。`ANTHROPIC_BASE_URL` が無ければモックで動く。
   * 値は `wrangler.jsonc` の vars、または `wrangler secret` / `.dev.vars` で渡す。
   */
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  ANTHROPIC_MODEL?: string;
  READER_FALLBACK_MODEL?: string;
  READER_PERSONA?: string;
  READER_BETA?: string;
}
