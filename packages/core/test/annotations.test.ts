/**
 * 引用の抽出と検証（`preview.py` の「引用が原文に実在すること」の移植）。
 * 捏造しないことが要件なので、実在しない引用と空アンカーの両方を固定する。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnnotations, extractQuote, isRevision, stopKind } from "../src/annotations.ts";

// 引用と論評という形をとる以上、再現量は少ないほうがよい。前後の窓が文脈を補う。
// 場所を特定できること（本文に一度しか現れないこと）が優先で、その中で最短を選ぶ。
test("extractQuote keeps the shortest quote that pins one place in the source", () => {
  const source =
    "Jevは、文章を生成せずに、選択や真偽判定などの「判断」を確率とともに返す、TypeSafe AI の判断特化型モデルだ";
  const comment = `根拠：「${source}」という一文そのまま。`;
  assert.equal(extractQuote(comment, source), source);
});

test("extractQuote refuses a quote that is not in the source", () => {
  assert.equal(extractQuote("根拠：「本文に無い文字列」", "まったく別の本文です。"), null);
});

test("extractQuote returns null when the reader quoted nothing", () => {
  assert.equal(extractQuote("理解：よく分からなかった。", "本文です。"), null);
});

test("isRevision ignores the filler forms the archive actually contains", () => {
  assert.equal(isRevision("修正：なし"), false);
  assert.equal(isRevision("修正：なし（初回）。"), false);
  assert.equal(isRevision("修正：特になし"), false);
  assert.equal(isRevision("修正：以前の理解を更新した"), true);
  assert.equal(isRevision("修正："), false);
});

test("buildAnnotations marks revisions, exits, and empty anchors", () => {
  const source = "較正とは、予測が統計的に当たる率と一致していること。";
  const annotations = buildAnnotations([
    {
      idx: 0,
      text: source,
      entry: "理解：定義が与えられた。修正：「較正」を別の意味だと思っていたが、ここで定義された。",
      stop: false,
    },
    { idx: 1, text: "次の段落です。", entry: "理解：なし（初回）。修正：なし", stop: false },
    { idx: 2, text: "三段目です。", entry: "（読者がここで読むのをやめた）", stop: true },
  ]);

  assert.equal(annotations[0].kind, "revision");
  assert.equal(annotations[0].status, "修正あり");
  // ログ中の「較正」は提示済み本文に実在するので引用として採用する。
  assert.equal(annotations[0].quote, "較正");
  assert.equal(annotations[1].kind, "observation");
  assert.equal(annotations[2].kind, "exit");
  assert.equal(annotations[2].status, "離脱");
  assert.equal(annotations[2].quote, null);
  assert.equal(annotations.length, 3);
});

// 結果ページの約束を機械で確かめる。「原稿は載せていません」は口約束にしない。
test("excerpts never reproduce the whole served text, and never join up into it", () => {
  // 断片は連結すると原稿に戻る（feed の性質）。ここでもその前提で組む。
  const chunks = [
    "この記事は、ある判断の理由を説明するものです。結論から言うと、選ばれたのは後者でした。",
    "最初の基準は速さでした。しかし速いだけでは足りないと分かりました。",
    "次に費用を見ました。ここで順位が入れ替わります。",
    "最後に安定性を見ました。これが決め手になりました。",
  ];
  const source = chunks.join("");
  const entries = chunks.map((text, idx) => ({
    idx,
    text,
    entry: `理解：段落${idx + 1}の話。\n根拠：「${text.slice(0, 12)}」\n未解決：なし\n修正：なし`,
    stop: false,
  }));

  const annotations = buildAnnotations(entries);
  const windows = annotations.map((a) => a.window).filter((w) => w !== null);
  assert.ok(windows.length > 0, "窓が1つも出ていない");

  // 1) 出している総量が、提示済み本文の4分の1を超えない。
  const shown = windows.reduce((sum, w) => sum + w.before.length + w.quote.length + w.after.length, 0);
  assert.ok(shown <= source.length * 0.25 + 1, `再現量が多すぎる: ${shown}/${source.length}`);

  // 2) どの窓も、原稿の全文を含まない。
  for (const w of windows) {
    assert.ok(!(w.before + w.quote + w.after).includes(source), "窓に全文が入っている");
  }

  // 3) 窓をすべて連結しても、原稿の連続した長い区間を復元できない。
  const joined = windows.map((w) => w.before + w.quote + w.after).join("");
  for (let length = 40; length <= source.length; length += 20) {
    for (let at = 0; at + length <= source.length; at += 10) {
      assert.ok(!joined.includes(source.slice(at, at + length)), "つなぐと原稿が復元できてしまう");
    }
  }
});

/**
 * 読者がやめたのか、読者を呼べなかったのかは別の出来事。混ぜると、原稿の
 * 問題でないものを原稿の問題として出してしまう。`workflow.ts` は失敗のときだけ
 * stopReason を書くので、その有無で分ける。
 */
test("buildAnnotations separates a reader's exit from a failed run", () => {
  const text = "較正とは、予測が統計的に当たる率と一致していること。";
  const declared = buildAnnotations([
    { idx: 0, text, entry: "理解：分からなくなったので読むのをやめる。", stop: true, stopReason: "end_turn" },
  ]);
  assert.equal(declared[0].kind, "exit");
  assert.equal(declared[0].status, "離脱");

  for (const reason of ["config_error", "empty", "refusal", "silent", "max_tokens", "length"]) {
    const failed = buildAnnotations([
      { idx: 0, text, entry: `（読者から空の応答。${reason}）`, stop: true, stopReason: reason },
    ]);
    assert.equal(failed[0].kind, "aborted", `${reason} が離脱として出ている`);
    assert.equal(failed[0].status, "中断");
  }
});

/**
 * 失敗の札は `workflow.ts` が書く語そのもの。API の stop_reason（end_turn など）を
 * そのまま載せると離脱と見分けがつかなくなるので、両方向を固定する。
 */
test("stopKind reads the labels the workflow actually writes", () => {
  for (const reason of ["config_error", "empty", "silent", "refusal", "max_tokens", "length", "reader_error"]) {
    assert.equal(stopKind(reason), "aborted", `${reason} が離脱として出ている`);
  }
  for (const reason of ["", "end_turn", "stop", "stop_sequence"]) {
    assert.equal(stopKind(reason), "exit", `${reason} が中断として出ている`);
  }
});

/**
 * 理解と未解決は元のログでは別の項目。1つの段落につなぐと、どこからが疑問なのか
 * 読めなくなる。画面まで別のまま運ぶ。
 */
test("buildAnnotations keeps the reader's question out of the understanding", () => {
  const text = "較正とは、予測が統計的に当たる率と一致していること。";
  const [annotation] = buildAnnotations([
    {
      idx: 0,
      text,
      entry: "理解：較正の定義が示された。\n根拠：「較正とは」\n未解決：なぜ確率で返すのかが分からない。\n修正：なし",
      stop: false,
    },
  ]);
  assert.equal(annotation.comment, "較正の定義が示された。");
  assert.equal(annotation.unresolved, "なぜ確率で返すのかが分からない。");
  assert.ok(!annotation.comment.includes("なぜ確率"), "理解の欄に問いが混ざっている");
});

/**
 * 引用が実在する俯瞰型の指摘には場所がある。位置を空のままにすると、帯だけが
 * 原稿全体を指して、同じカードに出ている引用と食い違う。
 */
test("buildAnnotations locates an overview note by where its quote appears", () => {
  const chunks = ["最初の段落です。", "二番目の段落です。", "三番目の段落です。"];
  const entries = chunks.map((text, idx) => ({
    idx,
    text,
    entry: `理解：段落${idx + 1}。\n根拠：「${text}」\n未解決：なし\n修正：なし`,
    stop: false,
  }));
  const [located, floating] = buildAnnotations(entries, "mind-tail", [
    { quote: "三番目の段落です。", comment: "終盤で話が戻っている。", role: "paper-plot" },
    { quote: "本文に無い文字列", comment: "全体の順序が入れ替わっている。", role: "paper-plot" },
  ]).filter((annotation) => annotation.role === "paper-plot");

  assert.deepEqual(located.covers, [2]);
  assert.equal(located.quote, "三番目の段落です。");
  // 引用が照合できないものは場所を持たせない（捏造しない）。
  assert.deepEqual(floating.covers, []);
  assert.equal(floating.quote, null);
});

test("判定で落ちた「修正」はカードを割らない", () => {
  // 自己申告は「修正：…」だが、判定役が訂正ではないと見た（revised: false）。
  // ここでカードが割れると、画面に「理解が変わった」札だけが残る。
  const entries = [
    { idx: 0, text: "冒頭の一文。", entry: "理解：最初の話。\n修正：なし", stop: false },
    {
      idx: 1,
      text: "続きの一文。",
      entry: "理解：続きの話。\n修正：前の段落の役割が具体化された。",
      stop: false,
      revised: false,
    },
  ];
  const cards = buildAnnotations(entries);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "observation");
  assert.deepEqual(cards[0].covers, [0, 1]);
});

test("判定が通った「修正」は独立したカードになる", () => {
  const entries = [
    { idx: 0, text: "冒頭の一文。", entry: "理解：最初の話。\n修正：なし", stop: false },
    {
      idx: 1,
      text: "続きの一文。",
      entry: "理解：続きの話。\n修正：前半の読み違いに気づいた。",
      stop: false,
      revised: true,
    },
  ];
  const cards = buildAnnotations(entries);
  assert.equal(cards.length, 2);
  assert.equal(cards[1].kind, "revision");
});
