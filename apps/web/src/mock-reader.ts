/**
 * mock の読者は3役とも台本で動かす。以前は slob-police と paper-plot を
 * `reader.kind !== "mock"` で丸ごと飛ばしていたため、**複数の役でレビューされる**
 * という条件を、課金なしで一度も検証できていなかった。ローカル検証ツールは
 * すべて mock を使うので、どれも1役しか見ていなかった。
 *
 * 返すのはモデルが返す生の文字列で、解析は本番と同じ関数を通す。引用は本文から
 * 実際に抜く（原文との照合を通らないと、指摘が引用なしで出て検証にならない）。
 */
export function mockSlobReply(chunk: string, index: number, total: number): string {
  // 中ほどで1回だけ止まる。最初の断片で止めると、以降の経路が一度も動かない。
  const stopAt = Math.min(Math.max(1, total - 1), Math.floor(total / 3) + 1);
  if (index !== stopAt) {
    return JSON.stringify({ quote: "", complaint: "", category: "", stop: false });
  }
  return JSON.stringify({
    quote: chunk.trim().slice(0, 14),
    complaint: "（モック）言い回しが引っかかる。",
    category: "translationese",
    stop: true,
  });
}

export function mockStructureReply(served: string): string {
  const notes = [0, 1]
    .map((n) => served.slice(n * 60, n * 60 + 24).trim())
    .filter((quote) => quote.length >= 8 && served.indexOf(quote) === served.lastIndexOf(quote))
    .map((quote) => ({
      quote,
      comment: "（モック）ここで予告した関係が、後半で回収されていない。",
      options: ["回収を結論より前に置く", "予告をやめる"],
    }));
  return JSON.stringify({ notes });
}
