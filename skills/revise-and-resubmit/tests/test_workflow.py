"""逐次提示・追質問・現在の赤入れビューアーの回帰検査。"""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ask
import feed
import render_review

class WorkflowTests(unittest.TestCase):
    def test_short_log_and_stop_hide_future_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            draft = root / 'draft.md'
            draft.write_text('冒頭です。二文目です。最後です。')
            f = feed.Feed(draft, root / 'run', ['mind-tail'], {}, 0, 'ja')
            reader = next(iter(f.readers.values()))
            f.start(reader)
            self.assertIn('refused', f.next(reader, ' '))
            self.assertEqual(reader['cursor'], 0)
            self.assertNotIn('refused', f.next(reader, '意味は分かった。'))
            self.assertEqual(reader['cursor'], 1)
            f.quit(reader, 'ここでやめる。')
            self.assertIn('error', f.next(reader, '続けたい。'))
            self.assertEqual(reader['cursor'], 1)
            f.flush()
            bundle = ask.bundle(root / 'run', 'mind-tail', 'どう読んだ？')
            self.assertIn('意味は分かった。', bundle)
            self.assertNotIn('最後です。', bundle)

    def test_file_mode_accepts_short_log_and_rejects_blank(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = {'cursor': 0}
            feed.record(root, state, 'ここでやめる。', quit_=True)
            self.assertTrue(json.loads((root/'log.jsonl').read_text())['quit'])
            with self.assertRaises(SystemExit):
                feed.record(root, state, ' ')

    def test_render_validates_source_and_quote_and_escapes_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = '# 題名\n\n<script>alert(1)</script>という例。\n'
            (root/'source.md').write_text(source)
            d = {'source': '/tmp/draft.md', 'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
                 'comments': [{'id':'R1','role':'human-feedbox','paragraph':1,
                 'quote':'という例。','comment':'<img src=x onerror=alert(1)>','kind':'human','status':'未対応'}]}
            (root/'annotations.json').write_text(json.dumps(d))
            self.assertEqual(render_review.render(root), (1,1))
            data = (root/'review-data.js').read_text()
            self.assertNotIn('<script>', data)
            self.assertIn('&lt;script&gt;', data)
            d['comments'][0]['quote']='本文にない引用'
            (root/'annotations.json').write_text(json.dumps(d))
            with self.assertRaisesRegex(ValueError, 'Quote mismatch'):
                render_review.render(root)
            d['source_sha256']='wrong'
            (root/'annotations.json').write_text(json.dumps(d))
            with self.assertRaisesRegex(ValueError, 'source.md'):
                render_review.render(root)

if __name__ == '__main__':
    unittest.main()
