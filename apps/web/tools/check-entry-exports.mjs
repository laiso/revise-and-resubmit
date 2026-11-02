#!/usr/bin/env node
/**
 * Worker の entry モジュールにある「危ない export」を起動前に見つける。
 *
 * module 形式の Worker では、entry モジュールの名前付き export がすべて
 * entrypoint と解釈される（handler object / Durable Object クラス / 関数）。
 * 文字列やオブジェクトを export すると、workerd はリクエストを処理する前に
 * Worker そのものの起動に失敗する:
 *
 *   Uncaught TypeError: Incorrect type for map entry 'INSTALL_COMMAND':
 *     the provided value is not of type 'function or ExportedHandler'.
 *
 * tsc では捕まらない（型としては正しい）ので、ここで静的に見る。
 * 実際に 2026-09-22 にこの形で dev サーバーが2台とも落ちた。
 *
 * 判定は「クラス宣言」「関数宣言」だけを安全とみなす。別ファイルから
 * import して再 export している名前は、そのファイルまで辿って
 * `export class` / `export function` があるかを確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

/** wrangler.jsonc の "main" を読む。jsonc なのでコメントを落としてから parse する。 */
function entryFile() {
  const raw = readFileSync(resolve(webRoot, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const config = JSON.parse(stripped);
  if (!config.main) throw new Error("wrangler.jsonc に main が無い");
  return resolve(webRoot, config.main);
}

/** ファイル内でクラス / 関数として宣言されている名前。 */
function declaredNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|function)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[2]);
  }
  return names;
}

/** `import { A as B } from "./x.ts"` と `export { A } from "./x.ts"` を拾う。 */
function importedFrom(source, file) {
  const map = new Map();
  const pattern =
    /^(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const spec = match[2];
    if (!spec.startsWith(".")) continue; // パッケージから来る値は対象外。
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) continue;
    const targetSource = readFileSync(target, "utf8");
    const targetNames = declaredNames(targetSource);
    for (const raw of match[1].split(",")) {
      const [original, alias] = raw.split(/\s+as\s+/).map((value) => value.trim());
      if (!original) continue;
      map.set(alias ?? original, targetNames.has(original));
    }
  }
  return map;
}

const file = entryFile();
const source = readFileSync(file, "utf8");
const shown = `apps/web/${file.slice(webRoot.length + 1)}`;
const local = declaredNames(source);
const imported = importedFrom(source, file);

const problems = [];
source.split("\n").forEach((line, index) => {
  const where = `${shown}:${index + 1}`;

  const valueExport = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (valueExport) {
    problems.push(
      `${where}  export ${valueExport[1]}: 値を export している。entry モジュールの export は ` +
        `handler / Durable Object クラス / 関数だけにする（export を外すか別ファイルへ移す）。`,
    );
  }

  const defaultExport = line.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;/);
  if (defaultExport && !local.has(defaultExport[1]) && !imported.has(defaultExport[1])) {
    problems.push(`${where}  export default ${defaultExport[1]}: 実体が同じファイルで宣言されていない。`);
  }

  for (const named of line.matchAll(/^export\s*\{([^}]*)\}/g)) {
    // `export { A } from "./x.ts"`（再 export）も同じ判定にする。
    const from = line.match(/\bfrom\s*["']([^"']+)["']/)?.[1];
    const origin = from ? importedFrom(`import {${named[1]}} from "${from}"`, file) : imported;
    for (const raw of named[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name || name.startsWith("type ")) continue; // 型だけの export は実行時に消える。
      if (local.has(name) || origin.get(name)) continue;
      problems.push(
        `${where}  export { ${name} }: クラス / 関数として宣言された実体が見つからない。` +
          `workerd は起動時にこれを entrypoint として読もうとして Worker ごと落ちる。`,
      );
    }
  }
});

if (problems.length > 0) {
  console.error("entry モジュールの export に問題がある:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\n値を外へ出すなら export を外すか、entry 以外のファイルに置く。\n" +
      "背景は apps/web/tools/check-entry-exports.mjs のコメントを参照。",
  );
  process.exit(1);
}

console.log(`entry モジュールの export: OK (${shown})`);
