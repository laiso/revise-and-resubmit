/**
 * The Python implementation is the reference for chunking. The committed
 * English snapshot is the regression baseline; the Japanese assertions mirror
 * `skills/revise-and-resubmit/tests/test_language.py`.
 *
 * The archived runs under `.revise-and-resubmit/` are gitignored (they contain
 * third-party article text), so the archive check runs only when present.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  JA_MAXIMUM,
  chunk,
  chunkHeader,
  count,
  jaChunks,
  jaSentences,
} from "../src/chunk.ts";

const skillTests = new URL("../../../skills/revise-and-resubmit/tests/", import.meta.url);
const archive = new URL("../../../.revise-and-resubmit/", import.meta.url);

test("english snapshot matches the python baseline", () => {
  const fixture = JSON.parse(readFileSync(new URL("english_baseline.json", skillTests), "utf8"));
  assert.deepEqual(chunk(fixture.draft), fixture.chunks);
});

/**
 * The Japanese snapshot was generated from `feed.py` while that file was still
 * the reference implementation (see decision record 0004). Once the Python was
 * removed this fixture became the only record of the split it produced, so a
 * failure here means the presentation condition moved, not that the fixture is
 * out of date.
 */
test("japanese snapshot matches the python baseline", () => {
  const fixture = JSON.parse(readFileSync(new URL("japanese_baseline.json", skillTests), "utf8"));
  const chunks = chunk(fixture.draft, "ja");
  assert.deepEqual(chunks, fixture.chunks);
  assert.deepEqual(
    chunks.map((_, index) => chunkHeader(index, chunks, "ja")),
    fixture.headers,
  );
});

test("japanese sentences keep closing quotes and ascii decimals", () => {
  assert.deepEqual(jaSentences("未確認です。価格は3.14ドルです。"), [
    "未確認です。",
    "価格は3.14ドルです。",
  ]);
  assert.deepEqual(jaSentences("彼は「やめた」と言った。」次です。"), [
    "彼は「やめた」と言った。」",
    "次です。",
  ]);
});

test("japanese chunks preserve the source and stay within the bound", () => {
  const draft = "文章です。".repeat(1000) + "あ".repeat(2000);
  const chunks = chunk(draft, "ja");
  assert.equal(chunks.join(""), draft);
  assert.ok(chunks.length > 1);
  assert.ok(Math.max(...chunks.map((c) => Array.from(c).length)) <= JA_MAXIMUM);
  assert.match(chunkHeader(0, chunks, "ja"), /characters remain/);
});

test("opening does not reveal later explanation", () => {
  const draft = "# 題名\n\n製品でv1を廃止する。これは利用者の作業例だ。担当を分ける。結果を集める。";
  const chunks = chunk(draft, "ja");
  assert.equal(chunks[0], "# 題名\n\n製品でv1を廃止する。");
  assert.equal(chunks[1], "これは利用者の作業例だ。");
  assert.equal(chunks[2], "担当を分ける。");
  assert.equal(chunks[3], "結果を集める。");
});

test("japanese counts are characters, not whitespace-split words", () => {
  assert.equal(count("あ い\nう", "ja"), 3);
  assert.equal(count("a b\nc", "en"), 3);
});

test("jaChunks bounds unpunctuated text without deleting characters", () => {
  const draft = "あ".repeat(1500);
  const chunks = jaChunks(draft);
  assert.equal(chunks.join(""), draft);
  // Python reference: [300, 300, 300, 600] — the tail is flushed whole because
  // the remainder fits under the bound.
  assert.deepEqual(
    chunks.map((c) => Array.from(c).length),
    [300, 300, 300, 600],
  );
});

test("archived run chunks the same way as the python run that produced it", (t) => {
  const run = new URL("note-01/", archive);
  const source = new URL("source.md", run);
  const manifest = new URL("manifest.json", run);
  if (!existsSync(source) || !existsSync(manifest)) {
    t.skip("archive fixture is gitignored and not present");
    return;
  }
  const expected = JSON.parse(readFileSync(manifest, "utf8")).presentation.chunks;
  const chunks = chunk(readFileSync(source, "utf8"), "ja");
  assert.equal(chunks.length, expected);
  // The passages the reader actually saw are in state.json; comparing the text
  // catches a split that drifts without changing how many pieces it makes.
  const state = new URL("mind-tail/state.json", run);
  if (existsSync(state)) {
    assert.deepEqual(chunks, JSON.parse(readFileSync(state, "utf8")).chunks);
  }
});
