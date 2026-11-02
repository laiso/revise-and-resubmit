/**
 * ペルソナのドリフト検出。core 側のプロンプトがスキルの原文から離れたら落ちる。
 * plan.md:「MVP では core 側にプロンプトを持ち、スキルとの一致はハッシュ比較などの
 * 差分検出に留める」。文字単位の一致は求めず、引用した語句が原文に在ることを見る。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { MIND_TAIL_PERSONA, MIND_TAIL_PROFILE } from "../src/personas.ts";

const personas = new URL("../../../skills/revise-and-resubmit/references/personas.md", import.meta.url);

test("mind-tail persona stays anchored to the skill's reference text", (t) => {
  if (!existsSync(personas)) {
    t.skip("skill references are not present");
    return;
  }
  const source = readFileSync(personas, "utf8");

  // 原文から引いた特徴的な語句がそのまま残っていること。
  for (const phrase of [
    "時間がかかる",
    "小さな一歩ずつ理解を築く",
    "説明の穴を黙って補修しない",
    "つながらなければ未解決にしておく",
    "完読は必須ではない",
    "過剰な無能さ",
  ]) {
    // 両方に在ることを求める。`inPersona === inSource` だと、どちらからも
    // 消えた語が false === false で素通りし、検査語が古びても落ちない。
    assert.ok(source.includes(phrase), `"${phrase}" が原文（personas.md）に無い。検査語が古い。`);
    assert.ok(MIND_TAIL_PERSONA.includes(phrase), `"${phrase}" がペルソナに無い。スキル側の変更に追随していない。`);
  }

  assert.ok(source.includes("earnest-v1"), "気質の名前が原文と一致しない");
  assert.equal(MIND_TAIL_PROFILE.temperament, "earnest-v1");
  assert.ok(source.includes("reading-report-v1"));
  assert.equal(MIND_TAIL_PROFILE.display, "reading-report-v1");
});
