import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location('preview', Path(__file__).resolve().parents[1] / 'scripts/preview.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.run = Path(self.temp.name)
        self.source = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n'
        self.digest = hashlib.sha256(self.source.encode()).hexdigest()
        (self.run / 'source.md').write_text(self.source)
        data = dict(source_sha256=self.digest, comments=[])
        (self.run / 'annotations.json').write_text(json.dumps(data))
        data.update(title='Custom', paragraphs=[dict(number=1, html='<strong>Custom formatting</strong>')])
        (self.run / 'review-data.js').write_text('window.RR_REVIEW = ' + json.dumps(data) + ';\n')
        (self.run / 'room.html').write_text('<script src="../../assets/review.js?v=123"></script>')
        (self.run / 'private.json').write_text('secret')
        self.start()

    def start(self):
        self.server = preview.PreviewServer(self.run)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def request(self, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        defaults = {'Origin': self.server.origin, 'X-CSRF-Token': self.server.token, 'Content-Type': 'application/json'}
        defaults.update(headers or {})
        conn.request('POST' if body is not None else 'GET', path,
                     json.dumps(body).encode() if body is not None else None, defaults)
        response = conn.getresponse()
        result = response.status, response.read()
        self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
        conn.close()
        return result

    def feedback(self, **changes):
        body = dict(source_sha256=self.digest, paragraph=1, quote='First', reaction='My reaction', request_id='request-1')
        body.update(changes)
        return body

    def test_persistence_dedup_and_readonly_payload(self):
        original_js = (self.run / 'review-data.js').read_bytes()
        status, first = self.request('/api/feedback', self.feedback())
        self.assertEqual(status, 200)
        self.assertEqual(self.request('/api/feedback', self.feedback()), (status, first))
        self.assertEqual(self.request('/api/feedback', self.feedback(reaction='Different'))[0], 409)
        self.stop()
        self.start()
        self.assertEqual(self.request('/api/feedback', self.feedback()), (status, first))
        comments = json.loads(self.request('/api/comments')[1])['comments']
        self.assertEqual(len(comments), 1)
        self.assertEqual(comments[0]['comment'], 'My reaction')
        js = self.request('/review-data.js')[1].decode()
        payload = json.loads(js.removeprefix('window.RR_REVIEW = ').strip().removesuffix(';'))
        self.assertEqual(payload['paragraphs'][0]['html'], '<strong>Custom formatting</strong>')
        self.assertEqual(len(payload['comments']), 1)
        self.assertEqual((self.run / 'review-data.js').read_bytes(), original_js)
        self.assertEqual((self.run / 'source.md').read_text(), self.source)

    def test_images_and_concurrent_posts(self):
        image = self.run / 'sample.png'
        image.write_bytes(b'image fixture')
        markup = '<img src="sample.png"><img src="private.json">'
        raw = (self.run / 'review-data.js').read_text()
        payload = json.loads(raw.removeprefix('window.RR_REVIEW = ').strip().removesuffix(';'))
        payload['paragraphs'][0]['html'] = markup
        (self.run / 'review-data.js').write_text('window.RR_REVIEW = ' + json.dumps(payload) + ';')
        js = self.request('/review-data.js')[1].decode()
        payload = json.loads(js.removeprefix('window.RR_REVIEW = ').strip().removesuffix(';'))
        import re
        url = re.search(r'src="(/media/[^" ]+)"', payload['paragraphs'][0]['html']).group(1)
        self.assertEqual(self.request(url), (200, b'image fixture'))
        self.assertEqual(self.request('/sample.png')[0], 404)
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda n: self.request('/api/feedback', self.feedback(request_id='parallel-' + str(n))), range(8)))
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(len(json.loads(self.request('/api/comments')[1])['comments']), 8)

    def test_validation(self):
        for changes in ({'source_sha256': 'wrong'}, {'paragraph': True}, {'paragraph': 3}, {'quote': 'first'}, {'quote': ''}, {'reaction': '  '}, {'request_id': '../x'}):
            with self.subTest(changes=changes):
                self.assertEqual(self.request('/api/feedback', self.feedback(**changes))[0], 409)
        (self.run / 'source.md').write_text('Changed manuscript')
        self.assertEqual(self.request('/api/feedback', self.feedback())[0], 409)
        self.assertEqual(self.request('/api/session')[0], 409)
        self.assertEqual(json.loads((self.run / 'annotations.json').read_text())['comments'], [])

    def test_security_and_allowlist(self):
        for headers in ({'Origin': 'http://evil.example'}, {'Origin': ''}, {'X-CSRF-Token': ''}, {'Host': 'evil.example'}):
            self.assertEqual(self.request('/api/feedback', self.feedback(), headers)[0], 403)
        self.assertEqual(self.request('/api/feedback', self.feedback(), {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/feedback', self.feedback(reaction='x' * 70000))[0], 413)
        for path in ('/private.json', '/../private.json', '/%2e%2e/private.json', '/assets/../scripts/preview.py', '/.preview.lock'):
            self.assertEqual(self.request(path)[0], 404)
        (self.run / 'report.md').symlink_to(self.run / 'private.json')
        self.assertEqual(self.request('/report.md')[0], 409)
        self.assertIn(b'/assets/review.js', self.request('/')[1])
        self.assertEqual(self.request('/assets/review.js')[0], 200)
        session = json.loads(self.request('/api/session')[1])
        self.assertEqual(session['source_sha256'], self.digest)
        self.assertEqual(session['csrf_token'], self.server.token)


if __name__ == '__main__':
    unittest.main()
