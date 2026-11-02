/**
 * mock の台本が、本番と同じ解析関数を通ることを固定する。
 *
 * slob-police と paper-plot は `reader.kind !== "mock"` で飛ばされていたので、
 * 「複数の役でレビューされる」という最低条件を、課金なしで一度も検証できて
 * いなかった。台本が解析を通らなければ、mock で3役を走らせても中身は空になる。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSlobNote, parseStructureNotes, chunk } from "@revise-and-resubmit/core";

import { mockSlobReply, mockStructureReply } from "../src/mock-reader.ts";

const SOURCE = [
  "# 検証用の原稿",
  "",
  "最初の段落です。ここでは、あとで説明すると予告した関係について書いています。",
  "",
  "次の段落では、設定を直したあとに、それを使っている環境へ届け続ける話をします。",
  "",
  "最後の段落です。予告した関係は、ここまで回収されていません。",
].join("\n");

test("mock の slob-police は、ちょうど一度だけ止まり、引用が本文に実在する", () => {
  const chunks = chunk(SOURCE, "ja");
  const stops = chunks
    .map((text, index) => parseSlobNote(mockSlobReply(text, index, chunks.length), index))
    .filter((note) => note.stop);

  assert.equal(stops.length, 1, "止まるのは一度だけ");
  const [stopped] = stops;
  assert.ok(stopped.structured, "JSON として読めていない");
  assert.ok(stopped.quote.length > 0, "引用が空だと、結果ページに引用なしで出る");
  assert.ok(chunks[stopped.index].includes(stopped.quote), "引用が渡した断片に実在しない");
  assert.equal(stopped.category, "translationese");
});

test("mock の slob-police は、最初の断片では止まらない", () => {
  // 第1断片で止めると、それ以降の経路が一度も動かないまま「検証した」ことになる。
  const chunks = chunk(SOURCE, "ja");
  const first = parseSlobNote(mockSlobReply(chunks[0], 0, chunks.length), 0);
  assert.equal(first.stop, false);
});

test("mock の paper-plot は、本文に実在する引用つきの指摘を返す", () => {
  const served = chunk(SOURCE, "ja").join("");
  const notes = parseStructureNotes(mockStructureReply(served), served);

  assert.ok(notes.length > 0, "指摘が0件だと、構造の経路を通ったか分からない");
  for (const note of notes) {
    assert.ok(served.includes(note.quote), `引用が本文に無い: ${note.quote}`);
    assert.ok(note.comment.length > 0);
    assert.ok(note.options.length > 0, "打ち手が空だと、選択肢の描画を検証できない");
  }
});

test("短い原稿でも、台本が壊れた指摘を作らない", () => {
  const chunks = chunk("短い原稿です。これだけ。", "ja");
  const served = chunks.join("");
  for (const note of parseStructureNotes(mockStructureReply(served), served)) {
    assert.ok(served.includes(note.quote));
  }
  const stops = chunks
    .map((text, index) => parseSlobNote(mockSlobReply(text, index, chunks.length), index))
    .filter((note) => note.stop);
  assert.ok(stops.length <= 1);
});
