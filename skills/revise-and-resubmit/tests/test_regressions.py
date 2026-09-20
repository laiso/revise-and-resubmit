import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import feed
import render_review

class RegressionTests(unittest.TestCase):
    def test_existing_sessions_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            draft = root/'draft.md'
            draft.write_text('一文です。二文です。三文です。')
            f = feed.Feed(draft, root/'run', ['existing'], {}, 0, 'ja')
            r = next(iter(f.readers.values()))
            f.start(r)
            f.quit(r, '離脱')
            before = {p.name:p.read_bytes() for p in (root/'run/existing').iterdir()}
            with self.assertRaises(FileExistsError):
                feed.Feed(draft, root/'run', ['new', 'existing'], {}, 0, 'ja')
            self.assertFalse((root/'run/new').exists())
            with patch.dict('os.environ', {}, clear=True), self.assertRaises(SystemExit):
                feed.cmd_start(SimpleNamespace(session=root/'run/existing', draft=draft, lang='ja', persona=None))
            self.assertEqual(before, {p.name:p.read_bytes() for p in (root/'run/existing').iterdir()})

    def test_served_quit_retry_preserves_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); draft=root/'draft.md'
            draft.write_text('一文です。二文です。三文です。')
            f=feed.Feed(draft, root/'run', ['reader'], {}, 0, 'ja')
            r=next(iter(f.readers.values())); f.start(r); f.quit(r,'離脱')
            before=(root/'run/reader/log.jsonl').read_bytes()
            self.assertIn('error',f.quit(r,'再送'))
            self.assertEqual(r['quit_at'],1)
            self.assertEqual(before,(root/'run/reader/log.jsonl').read_bytes())

    def test_file_quit_retry_and_final_note(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict('os.environ', {}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            root=Path(tmp)
            for cursor,done in [(0,False),(2,True)]:
                d=root/str(cursor); d.mkdir()
                feed.save(d, {'cursor':cursor,'done':done,'chunks':['a','b']})
                args=SimpleNamespace(session=d,log='反応')
                feed.cmd_quit(args)
                before={p.name:p.read_bytes() for p in d.iterdir()}
                with self.assertRaises(SystemExit):
                    feed.cmd_quit(args)
                self.assertEqual(before,{p.name:p.read_bytes() for p in d.iterdir()})
                state=json.loads((d/'state.json').read_text())
                self.assertEqual(state['quit_at'],1 if cursor==0 else None)
                self.assertEqual(json.loads((d/'log.jsonl').read_text())['chunk'],1 if cursor==0 else 2)

    def test_highlight_keeps_attributes_and_merges_overlaps(self):
        markup=render_review.inline('[example.com](https://example.com)')
        result=render_review.highlight(markup, ['example.com','example'])
        self.assertEqual(result,'<a href="https://example.com"><mark>example.com</mark></a>')
        self.assertEqual(render_review.highlight(render_review.inline('a `b` c'), ['a `b`']),
                         '<mark>a </mark><code><mark>b</mark></code> c')
        self.assertNotIn('<script>',render_review.highlight(render_review.inline('<script>'), ['<script>']))

if __name__ == '__main__':
    unittest.main()
