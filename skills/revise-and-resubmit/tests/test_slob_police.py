"""slob-policeの停止記録に必要なフィードの契約。モデルの判断は検査しない。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import feed


class SlobPoliceTests(unittest.TestCase):
    def test_stop_does_not_advance_or_append_on_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            draft = root / 'source.md'
            draft.write_text('最初の文です。未読の文です。')
            server = feed.Feed(draft, root / 'run', ['slob-police'], {}, 0, 'ja')
            reader = next(iter(server.readers.values()))
            server.start(reader)
            entry = json.dumps({'decision': 'stop', 'quote': '最初の文です。', 'reason': '試験用の停止'})
            server.quit(reader, entry)
            saved = (root / 'run/slob-police/log.jsonl').read_text()
            self.assertIn('error', server.next(reader, '続行'))
            self.assertIn('error', server.quit(reader, '再送'))
            self.assertEqual(reader['cursor'], 0)
            self.assertEqual(reader['quit_at'], 1)
            self.assertEqual((root / 'run/slob-police/log.jsonl').read_text(), saved)
            self.assertNotIn('未読', saved)

    def test_last_chunk_preserves_explicit_stop_despite_final_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            draft = root / 'source.md'
            draft.write_text('最後の文です。')
            server = feed.Feed(draft, root / 'run', ['slob-police'], {}, 0, 'ja')
            reader = next(iter(server.readers.values()))
            server.start(reader)
            server.quit(reader, json.dumps({'decision': 'stop', 'reason': '試験用の不満'}))
            record = json.loads((root / 'run/slob-police/log.jsonl').read_text())
            self.assertFalse(record['quit'])  # 最終断片はフィード上ではFINAL。
            self.assertEqual(json.loads(record['entry'])['decision'], 'stop')
            self.assertTrue(reader['done'])
            self.assertEqual(record['chunk'], 1)


if __name__ == '__main__':
    unittest.main()
