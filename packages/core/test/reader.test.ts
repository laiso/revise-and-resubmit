/**
 * 読者プロンプトと構造化のテスト。鍵が無くても固定できる部分。
 * 「未提示の本文を渡さない」「停止申告を機械的に読む」「壊れた出力でも記録を失わない」
 * の3点が要件。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReaderMessages, buildReaderSystem, formatNote, parseReaderNote } from "../src/reader.ts";

const persona = "あなたは mind-tail。理解力は浅いが頑張って読む読者である。";

const note = (index: number, understanding: string) => ({
  index,
  understanding,
  evidence: "引用",
  connection: "接続",
  unresolved: "なし",
  revision: "なし",
  stop: false,
  structured: true,
});

test("system carries the persona, the brief, and the output instruction", () => {
  const system = buildReaderSystem(persona);
  assert.ok(system.includes(persona));
  assert.ok(system.includes("incremental understanding probe"));
  assert.ok(system.includes("JSON"));
});

// 位置の表示が読者の記録に混ざると、結果ページにそのまま載る（room.md）。
// 実測で Gemini と Sonnet と Haiku の3モデルが「CHUNK 6」を引き合いに出した。
test("the reader is told not to cite chunk numbers", () => {
  const system = buildReaderSystem("（ペルソナ）");
  assert.ok(system.includes("断片の番号を、記録の中で引き合いに出さないこと"));
  assert.ok(system.includes("本文の言葉で言うこと"));
});

test("the turn carries the position header and only the current chunk", () => {
  const other = "この文字列は別の断片にしかない。";
  const messages = buildReaderMessages([
    { index: 3, total: 17, chunk: "第四の断片である。", lang: "ja" },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.ok(messages[0].content.includes("CHUNK 4/17"));
  assert.ok(messages[0].content.includes("第四の断片である。"));
  assert.ok(!messages[0].content.includes(other));
});

test("messages alternate and the whole prefix is reusable across turns", () => {
  const messages = buildReaderMessages([
    { index: 0, total: 3, chunk: "最初の断片。", lang: "ja", note: note(0, "第一の理解") },
    { index: 1, total: 3, chunk: "次の断片。", lang: "ja", note: note(1, "第二の理解") },
    { index: 2, total: 3, chunk: "最後の断片。", lang: "ja" },
  ]);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  // 伸びる会話なので、前のリクエストのメッセージ列がそのまま接頭辞になる。
  const previous = buildReaderMessages([
    { index: 0, total: 3, chunk: "最初の断片。", lang: "ja", note: note(0, "第一の理解") },
    { index: 1, total: 3, chunk: "次の断片。", lang: "ja" },
  ]);
  assert.deepEqual(messages.slice(0, previous.length), previous);
  assert.ok(messages[1].content.includes("第一の理解"));
  assert.ok(!messages[3].content.includes("第一の理解"));
});

test("parses a structured reply into the archive's log layout", () => {
  const note = parseReaderNote(
    JSON.stringify({
      understanding: "筆者が手法に否定的だと分かった。",
      evidence: "「有効ではない」という一文。",
      connection: "前段の評価とつながる。",
      unresolved: "「脱臭スキル」が何かは不明。",
      revision: "一般論への批判だと思っていたが、自分の道具の説明だった。",
      stop: false,
    }),
    2,
  );
  assert.equal(note.structured, true);
  assert.equal(note.stop, false);
  assert.equal(note.index, 2);
  assert.equal(
    formatNote(note),
    [
      "理解：筆者が手法に否定的だと分かった。",
      "根拠：「有効ではない」という一文。",
      "接続：前段の評価とつながる。",
      "未解決：「脱臭スキル」が何かは不明。",
      "修正：一般論への批判だと思っていたが、自分の道具の説明だった。",
    ].join("\n"),
  );
});

test("accepts a code-fenced reply and a textual stop", () => {
  const note = parseReaderNote('```json\n{"understanding":"読むのをやめる。","stop":"はい","unresolved":"表現が許容できない。"}\n```', 4);
  assert.equal(note.structured, true);
  assert.equal(note.stop, true);
  assert.equal(note.evidence, "なし");
});

test("falls back to the labeled free text the archive uses", () => {
  const note = parseReaderNote(
    "理解：較正の定義が与えられた。\n根拠：「80%と言えば実際に8割当たる」。\n未解決：なし\n修正：比喩だと思っていたが実際の実験だった。",
    1,
  );
  assert.equal(note.understanding, "較正の定義が与えられた。");
  assert.equal(note.evidence, "「80%と言えば実際に8割当たる」。");
  assert.equal(note.revision, "比喩だと思っていたが実際の実験だった。");
  assert.equal(note.stop, false);
});

test("keeps an unparseable reply as a free-text record instead of losing it", () => {
  const note = parseReaderNote("よく分からないが、たぶん何かの説明だと思う。", 5);
  assert.equal(note.structured, false);
  assert.equal(note.understanding, "よく分からないが、たぶん何かの説明だと思う。");
  assert.equal(note.stop, false);
});

test("stop defaults to false and never triggers on filler", () => {
  for (const revision of ["なし", "特になし", ""]) {
    const note = parseReaderNote(JSON.stringify({ understanding: "理解", revision }), 0);
    assert.equal(note.stop, false);
  }
});
