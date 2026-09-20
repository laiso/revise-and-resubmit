"""Run with: python3 -m unittest discover -s tests (from the skill directory)."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import feed
import language


class LanguageTests(unittest.TestCase):
    def test_english_snapshot(self):
        fixture = json.loads(Path(__file__).with_name('english_baseline.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            draft = Path(directory) / 'draft.md'
            draft.write_text(fixture['draft'])
            self.assertEqual(feed.chunk(fixture['draft']), fixture['chunks'])

    def test_japanese_sentences(self):
        self.assertEqual(language.ja_sentences('未確認です。価格は3.14ドルです。'),
                         ['未確認です。', '価格は3.14ドルです。'])

    def test_japanese_chunk_preservation(self):
        draft = '文章です。' * 1000 + 'あ' * 2000
        chunks = feed.chunk(draft, 'ja')
        self.assertEqual(''.join(chunks), draft)
        self.assertGreater(len(chunks), 1)
        self.assertLessEqual(max(map(len, chunks)), 700)
        self.assertIn('characters remain', feed.chunk_header(0, chunks, 'ja'))

    def test_opening_does_not_reveal_later_explanation(self):
        draft = '# 題名\n\n製品でv1を廃止する。これは利用者の作業例だ。担当を分ける。結果を集める。'
        chunks = feed.chunk(draft, 'ja')
        self.assertEqual(chunks[0], '# 題名\n\n製品でv1を廃止する。')
        self.assertEqual(chunks[1], 'これは利用者の作業例だ。')
        self.assertEqual(chunks[2], '担当を分ける。')
        self.assertEqual(chunks[3], '結果を集める。')

    def test_language_persists_in_both_feed_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            draft = root / 'draft.md'
            draft.write_text('文です。' * 500)
            subprocess.run([sys.executable, str(SCRIPTS / 'feed.py'), 'start', str(draft),
                            '--session', str(root / 'session'), '--lang', 'ja'],
                           check=True, capture_output=True)
            state = json.loads((root / 'session/state.json').read_text())
            self.assertEqual(state['language'], 'ja')
            server = feed.Feed(draft, root / 'served', ['mind-tail'], {}, 0, 'ja')
            reader = next(iter(server.readers.values()))
            self.assertIn('characters total', server.start(reader)['briefing'])
            server.next(reader, '主体と作業の関係が分かった。')
            self.assertEqual(reader['cursor'], 1)
            server.flush()
            state = json.loads((root / 'served/mind-tail/state.json').read_text())
            self.assertEqual(state['language'], 'ja')


if __name__ == '__main__':
    unittest.main()
