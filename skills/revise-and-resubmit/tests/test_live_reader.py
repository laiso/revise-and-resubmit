"""明示実行する実モデル試験（判断理由の妥当性は保存ログで人間が確認）。

RUN_LIVE_READER=1 python3 -m unittest discover -s tests -p test_live_reader.py
LIVE_MODEL: 比較するモデルID（省略時はCLIの既定値。実際のモデルはevents.jsonlに残る）。
LIVE_BUDGET_USD: 1ケースのAPI予算上限（既定0.50）。上限到達は未完了。
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import feed


@unittest.skipUnless(os.environ.get('RUN_LIVE_READER') == '1', '実モデルは明示実行のみ')
class LiveReaderTests(unittest.TestCase):
    def test_slob_police_pair(self):
        model = os.environ.get('LIVE_MODEL')
        self.assertIsNotNone(shutil.which('claude'), 'claude CLIが必要です')
        cases = json.loads((Path(__file__).parent / 'live_cases.json').read_text())
        protocol = (ROOT / 'references/slob-police.md').read_text()
        # 一時ディレクトリは証拠として残す。期待結果は読者に渡さない。
        output = Path(tempfile.mkdtemp(prefix='rr-live-'))
        print(f'\n実モデル試験の記録: {output}', flush=True)
        for case in cases:
            with self.subTest(case=case['id']):
                run = output / case['id']
                run.mkdir()
                draft = run / 'source.md'
                draft.write_text(case['text'])
                reader_feed = feed.Feed(draft, run / 'feed', ['slob-police'],
                                        {'slob-police': case['audience']}, 0.08, 'ja')
                handler = type('CaseHandler', (feed.Handler,), {'feed': reader_feed})
                server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
                handler.server_ref = server
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                token, reader = next(iter(reader_feed.readers.items()))
                address = f'http://127.0.0.1:{server.server_port}/{token}'
                command = f'{shlex.quote(sys.executable)} {shlex.quote(str(ROOT / "scripts/feed.py"))}'
                prompt = (
                    protocol + '\n\nあなた自身が履歴のない独立した読者です。子エージェントは起動しません。\n'
                    + f'想定読者: {case["audience"]}\n'
                    + f'READER_FEEDは環境変数に設定済みです。フィード操作: {command} '
                    + 'start / next --log / quit --log のみをBashで実行してください。\n'
                    + '原稿・状態・テスト・他のファイルは読みません。レポートファイルの作成は進行役が担当します。\n'
                    + '各--logはJSON文字列とし、decision（continueまたはstop）、quote（原文の引用、なければ空文字）、'
                    + 'reason（具体的な理由）、understanding（現在の理解）を記録してください。\n'
                    + '異議がなければ最後もcontinueとして記録し、END後はquitで完了してください。'
                )
                args = ['claude', '-p', '--safe-mode',
                        '--tools', 'Bash', '--allowedTools', f'Bash({command} *)',
                        '--max-budget-usd', os.environ.get('LIVE_BUDGET_USD', '0.50'),
                        '--max-turns', '12', '--output-format', 'stream-json', '--verbose']
                if model:
                    args.extend(['--model', model])
                (run / 'manifest.json').write_text(json.dumps({
                    'model_requested': model, 'command': args, 'prompt': prompt,
                    'source_sha256': hashlib.sha256(draft.read_bytes()).hexdigest(),
                    'protocol_sha256': hashlib.sha256(protocol.encode()).hexdigest(),
                    'expectation': case['expected'],
                    'human_review': case['review'],
                    'scope': '読者とfeedの結合。スキル探索・親の委譲・画面・意味の自動採点は対象外',
                }, ensure_ascii=False, indent=2))
                try:
                    with tempfile.TemporaryDirectory(prefix='rr-reader-') as cwd:
                        with (run / 'events.jsonl').open('w') as stdout, (run / 'stderr.txt').open('w') as stderr:
                            result = subprocess.run(args, input=prompt, text=True, cwd=cwd,
                                                    env={**os.environ, 'READER_FEED': address},
                                                    stdout=stdout, stderr=stderr, timeout=180)
                    self.assertEqual(result.returncode, 0, f'CLI失敗・未完了: {run}')
                    events = [json.loads(line) for line in (run / 'events.jsonl').read_text().splitlines() if line.strip()]
                    finals = [e for e in events if e.get('type') == 'result']
                    self.assertTrue(finals, f'CLI完了結果なし: {run}')
                    self.assertEqual(finals[-1].get('subtype'), 'success', f'予算等による未完了: {run}')
                    self.assertFalse(finals[-1].get('is_error'), f'モデル実行エラー: {run}')
                    self.assertTrue(reader['done'], f'読書未完了: {run}')
                    self.assertTrue(reader['log'], f'ログなし: {run}')
                    decisions = []
                    for record in reader['log']:
                        entry = json.loads(record['entry'])
                        self.assertIn(entry['decision'], ('continue', 'stop'))
                        self.assertTrue(entry['reason'].strip())
                        self.assertTrue(entry['understanding'].strip())
                        visible = ''.join(reader_feed.chunks[:record['chunk']])
                        self.assertIn(entry['quote'], visible)
                        decisions.append(entry)
                    stops = [i for i, e in enumerate(decisions) if e['decision'] == 'stop']
                    if stops:
                        self.assertEqual(stops, [len(decisions) - 1], 'stop後に読書を継続')
                    self.assertEqual('stop' if stops else 'continue', case['expected'])
                    if stops:
                        self.assertIn(case['target'], decisions[stops[0]]['quote'])
                    else:
                        self.assertEqual(reader['log'][-1]['chunk'], len(reader_feed.chunks))
                    self.assertEqual(draft.read_text(), case['text'])
                    print(f'{case["id"]}: 機械的検査成功。理由の妥当性は要確認: {run}', flush=True)
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join()
                    reader_feed.flush()


if __name__ == '__main__':
    unittest.main()
