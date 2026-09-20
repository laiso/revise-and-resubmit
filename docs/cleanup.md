# 公開前の整理と検証

2026-09-20。旧first-readerの流し読み、記憶テスト、信頼指標、注意力メーターを取り除いた。

削除したもの：skim.py、signals.py、recall.py、room.py、room_template.html、使われていないeditorial-light.cssとhuman-feedbox.css。旧機能用のテストとスナップショットも整理した。

残したもの：feed.py（逐次提示とログ）、ask.py（ログからの追質問）、language.py（日本語の分割）、render_review.py（赤入れ画面）、現行の共通HTML/CSS/JS。feed.pyとask.pyの由来はクレジットとライセンスに残している。

旧読者名S/Kやkeen/skeptic、感情指標needleの要求、ask.pyの流し読み分岐、自然な読書速度を再現できるという説明を削除。ログは空欄を拒否するが、短いというだけでは拒否しない。待機時間は早送り防止の制約として維持する。新規保存先は.revise-and-resubmit/。過去のレビュー記録は移動・削除しない。

確認したこと：

- Agent Pluginsの公式JSON Schemaに対するmanifest検証。
- Codex互換manifestとスキルfrontmatterの検証。
- Pythonテスト8件。冒頭の逐次提示、本文分割、言語の保存、短いログ、空ログ拒否、停止後の取得拒否、追質問で未提示の本文を含めないこと、原稿ハッシュ・引用の照合、HTMLのエスケープ。
- 既存ベンチマーク原稿の提示単位が整理前と同一であること。
- 既存の指摘データから赤入れ画面を再生成できること。

この整理後にモデルによる原稿レビューは再実行していない。プラグインの実インストール、自動検出、他クライアントでのレビュー実行は未検証。
