/**
 * 「修正」が本物の訂正かどうかの判定。`typesafe/jev` を AI Gateway 経由で呼ぶ。
 *
 * 読者の自己申告は当てにならない。実測では、報告された「修正」の大半が
 * 「話が先に進んだだけ」だった（Sonnet の zenn-01 で 8件中 1件）。
 * 正規表現は「なし以外」を数えているだけなので、ここを分けないと
 * 画面の強調が意味を失う。
 *
 * 手元の正解8件で 7件一致。進行型はすべて 0.17 以下に落ちた。
 * 判定は間違いうるので、**元のログは必ず残す**。境界は強調しない。
 */

export interface JudgeConfig {
  /** https://gateway.ai.cloudflare.com/v1/{account}/{gateway} */
  baseUrl: string;
  aigToken: string;
}

/** これ以上なら訂正として扱う。0.3〜0.5 は境界として強調しない。 */
export const GENUINE = 0.5;

const CRITERIA = {
  true: "以前の解釈が間違っていた、成り立たなくなった、思い違いだったと認めている。",
  false: "話が先に進んで情報が増えただけ。予想が当たった、未知が既知になった、具体化された。",
};

/** 訂正らしさ（0〜1）。呼べなかったときは -1（判定なし）。 */
export async function judgeRevision(config: JudgeConfig, revision: string): Promise<number> {
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/workers-ai/run/typesafe/jev`, {
      method: "POST",
      headers: { "cf-aig-authorization": `Bearer ${config.aigToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: `読者の記録: ${revision}`,
        questions: {
          genuine: {
            type: "noul",
            instructions: "この記録は、読者が以前の理解を誤りと認めて訂正したものか。",
            criteria: CRITERIA,
          },
        },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return -1;
    }
    const parsed = (await response.json()) as { result?: { answers?: { genuine?: { noul?: number } } } };
    const value = parsed.result?.answers?.genuine?.noul;
    return typeof value === "number" ? value : -1;
  } catch {
    return -1;
  }
}
