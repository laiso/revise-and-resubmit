"""実モデル試験の判定が誤った合否を返さないことを、実際のFeed操作で検査する。"""
import json
from pathlib import Path
import tempfile
import unittest

from test_live_reader import assert_reader_result, feed


class LiveReaderValidationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.cases = json.loads((Path(__file__).parent / 'live_cases.json').read_text())

    def start_case(self, case):
        draft = self.root / 'source.md'
        draft.write_text(case['text'])
        server = feed.Feed(draft, self.root / 'run', ['slob-police'], {}, 0, 'ja')
        reader = next(iter(server.readers.values()))
        server.start(reader)
        server.next(reader, self.entry('continue'))
        return server, reader

    @staticmethod
    def entry(decision, quote=''):
        return json.dumps({'decision': decision, 'quote': quote,
                           'reason': '具体的な効果を示さない誇張だ' if decision == 'stop' else '具体的な案内だ',
                           'understanding': '保存処理が変更された'})

    def test_accepts_alternative_quote_at_first_objection(self):
        case = self.cases[0]
        server, reader = self.start_case(case)
        server.quit(reader, self.entry('stop', 'あなたの作業を次のレベルへ連れていき'))
        assert_reader_result(self, server, reader, case)

    def test_rejects_stop_after_reading_later_chunk(self):
        case = self.cases[0]
        server, reader = self.start_case(case)
        server.next(reader, self.entry('continue'))
        server.quit(reader, self.entry('stop', '無限の可能性'))
        with self.assertRaisesRegex(AssertionError, '期待した提示位置で停止していない'):
            assert_reader_result(self, server, reader, case)

    def test_rejects_empty_or_previous_chunk_quote(self):
        case = self.cases[0]
        server, reader = self.start_case(case)
        server.quit(reader, self.entry('stop', '無限の可能性'))
        for quote, message in [('', '停止理由の引用が空'),
                               ('保存処理を変更しました。', '停止した断片から引用していない')]:
            with self.subTest(quote=quote):
                reader['log'][-1]['entry'] = self.entry('stop', quote)
                with self.assertRaisesRegex(AssertionError, message):
                    assert_reader_result(self, server, reader, case)

    def test_accepts_completed_control(self):
        case = self.cases[1]
        server, reader = self.start_case(case)
        while not reader['done']:
            server.next(reader, self.entry('continue'))
        server.quit(reader, self.entry('continue'))
        assert_reader_result(self, server, reader, case)


if __name__ == '__main__':
    unittest.main()
