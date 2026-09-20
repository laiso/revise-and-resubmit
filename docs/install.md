# インストール

Python 3と、履歴を共有しないサブエージェントを起動できる環境を使います。質問ツールがないクライアントでは、人間への質問は会話で行います。プラグイン形式に対応していることだけでは、独立した読者を実行できるとは限りません。

## 配布形式

このリポジトリは、スキルだけを含む[Agent Plugins 1.0.0](https://agent-plugins.org/plugin-authors/build-an-agent-plugin)パッケージです。MCPは必須ではありません。ルートのplugin.jsonとskills/revise-and-resubmit/が共通部分、.codex-plugin/plugin.jsonはCodex向けの互換manifestです。

## Claude Codeで使う

リポジトリを取得して、スキル一式を個人用の配置先へコピーします。

```sh
git clone https://github.com/laiso/revise-and-resubmit.git
mkdir -p ~/.claude/skills
cp -R ./revise-and-resubmit/skills/revise-and-resubmit ~/.claude/skills/
```

同名のスキルが既にある場合は上書き前に確認してください。Claude Codeで原稿を指定します。

```text
/revise-and-resubmit 原稿.md
```

配置先と呼び出し方は[Claude Code公式ドキュメント](https://code.claude.com/docs/en/skills)に基づきます。

## Codexでスキルとして使う

[公式のスキル配置先](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)へ、プラグインを登録する前にスキルとして使う場合は、リポジトリを取得し、スキル一式を配置します。

```sh
git clone https://github.com/laiso/revise-and-resubmit.git
mkdir -p ~/.agents/skills
cp -R ./revise-and-resubmit/skills/revise-and-resubmit ~/.agents/skills/
```

既に同名のスキルがある場合は上書きせず、既存版の置換か併存かを先に決めてください。新しい会話で、原稿のパスを添えて依頼します。

```text
$revise-and-resubmit 原稿.md
```

Codexでは`$revise-and-resubmit`で呼び出せます。CLIでは`/skills`から選択する方法もあります。これはスキルの導入であり、プラグイン一覧への登録ではありません。

## Codexでプラグインとして使う

公式の[Build plugins](https://learn.chatgpt.com/docs/build-plugins)に従い、取得したフォルダをローカルマーケットプレイスへ登録してからインストールします。Codexには次のように依頼できます。

```text
$plugin-creator /絶対パス/revise-and-resubmit を個人のローカルマーケットプレイスに登録してください。
既存のスキルとmanifestを使ってください。
```

登録後、プラグイン一覧からインストールし、新しい会話で試します。登録先が既定の個人マーケットプレイスなら、CLIのインストールコマンドは次です。

```sh
codex plugin add revise-and-resubmit@personal
```

マーケットプレイス名が異なる場合は登録された名前を使います。`codex plugin add`はmanifestのあるGitリポジトリを直接受け取るコマンドではありません。このリポジトリ自体にはマーケットプレイスのカタログを同梱していません。

## レビュー画面を開き直す

レビュー実行後はローカルWebアプリのURLをブラウザで開きます。サーバーを止めた後で開き直す場合は、スキルのディレクトリで次を実行します。

```sh
python3 scripts/preview.py /原稿の隣/.revise-and-resubmit/実行名 --open-browser
```

Pythonが127.0.0.1の空きポートを使い、URLを表示します。画面から保存した指摘は実行ディレクトリのannotations.jsonに残ります。原稿本文は変更しません。終了するにはCtrl-Cを押します。HTMLファイルだけを開く場合は閲覧専用です。

## 開発用の検証

```sh
python3 -m unittest discover -s skills/revise-and-resubmit/tests
```

レビューの保存先は原稿の隣の.revise-and-resubmit/です。HTMLはスキル内の共通資産を相対パスで参照するため、ページだけを移す場合は資産も一緒に配置する必要があります。

2026-09-20時点で、パッケージ構造、公式スキーマ、Codex CLI 0.154.0のコマンド形式、Pythonの動作を確認しています。プラグイン一覧からの実インストールと、新しい会話での自動検出は別途確認が必要です。公開・マーケットプレイスへの申請は行っていません。
