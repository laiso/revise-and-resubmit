/**
 * 読者を呼べない「設定の誤り」を、一時的な失敗と区別する。
 *
 * 一時的な失敗（429・5xx・ネットワーク）は step のリトライに任せる。設定の誤り
 * （プラン対象外のモデル、残高不足、認証）は何度やっても同じなので、リトライせず
 * Run を止め、**ライブ画面に理由を出す**（黙ってハングさせない）。
 */
export class ReaderConfigError extends Error {
  readonly summary: string;

  constructor(summary: string) {
    super(summary);
    this.name = "ReaderConfigError";
    this.summary = summary;
  }
}
