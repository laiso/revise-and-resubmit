"""Loopback-only review preview with durable human feedback. Python stdlib only."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import tempfile
from urllib.parse import urlsplit
import webbrowser

ASSETS = Path(__file__).resolve().parents[1] / 'assets'
ASSET_NAMES = {'review.css', 'review.js', 'human-feedbox.js'}
REPORTS = {'room.html', 'report.md', 'structure.md', 'slob-police.md', 'annotations.json', 'source.md'}
MAX_BODY = 65536


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class PreviewServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, run, port=0):
        self.run = Path(run).resolve()
        self.token = secrets.token_urlsafe(32)
        self.media = {}
        self.media_root = next((p for p in self.run.parents if (p / '.git').exists()), self.run.parent)
        self.data()  # Refuse stale or malformed runs before publishing a URL.
        super().__init__(('127.0.0.1', port), Handler)
        self.origin = 'http://127.0.0.1:' + str(self.server_port)

    def file(self, name):
        path = self.run / name
        if path.is_symlink() or path.resolve().parent != self.run:
            raise ValueError('Unsafe run file')
        return path

    def data(self):
        source = self.file('source.md').read_bytes()
        digest = hashlib.sha256(source).hexdigest()
        data = json.loads(self.file('annotations.json').read_text(encoding='utf-8'))
        if data['source_sha256'] != digest:
            raise ValueError('source.md does not match annotation source hash')
        if not isinstance(data['comments'], list):
            raise ValueError('Invalid comments')
        return data, source.decode('utf-8')

    def map_images(self, markup):
        def replace(match):
            value = html.unescape(match.group(2))
            parsed = urlsplit(value)
            if parsed.scheme or parsed.netloc or value.startswith('/') or parsed.query or parsed.fragment:
                return match.group(0)
            candidate = self.run / value
            resolved = candidate.resolve()
            if (resolved.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.gif'}
                    or not resolved.is_relative_to(self.media_root) or not resolved.is_file()
                    or any(part.is_symlink() for part in (candidate, *candidate.parents))):
                return match.group(0)
            key = hashlib.sha256(str(resolved).encode()).hexdigest()[:24]
            self.media[key] = resolved
            return match.group(1) + '/media/' + key + match.group(3)
        return re.sub(r'(<img\b[^>]*?\bsrc=["\'])([^"\']+)(["\'])', replace, markup, flags=re.I)

    def save_feedback(self, body):
        # flock also serializes writers from another preview process for this run.
        lock = self.file('.preview.lock')
        with lock.open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            data, source = self.data()
            if body.get('source_sha256') != data['source_sha256']:
                raise ValueError('Source hash mismatch')
            paragraph, quote, reaction, request_id = (body.get(k) for k in ('paragraph', 'quote', 'reaction', 'request_id'))
            blocks = re.split(r'\n\s*\n', source.strip())[1:]
            if type(paragraph) is not int or not 1 <= paragraph <= len(blocks):
                raise ValueError('Invalid paragraph')
            if not isinstance(quote, str) or not quote.strip() or quote not in blocks[paragraph - 1]:
                raise ValueError('Quote does not exactly match source paragraph')
            if not isinstance(reaction, str) or not reaction.strip():
                raise ValueError('Reaction is required')
            if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', request_id):
                raise ValueError('Invalid request_id')
            for old in data['comments']:
                if old.get('request_id') == request_id:
                    if (old.get('paragraph'), old.get('quote'), old.get('comment')) != (paragraph, quote, reaction):
                        raise ValueError('request_id already used for different feedback')
                    return old
            comment = dict(id='human-' + secrets.token_hex(8), role='human-feedbox', kind='human',
                           paragraph=paragraph, quote=quote, comment=reaction,
                           status='collected/unaddressed', request_id=request_id,
                           source_sha256=data['source_sha256'], created_at=datetime.now(timezone.utc).isoformat())
            data['comments'].append(comment)
            atomic_json(self.file('annotations.json'), data)
            return comment


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value, content_type='application/json; charset=utf-8'):
        payload = json.dumps(value, ensure_ascii=False).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def trusted_host(self):
        return self.headers.get('Host') == '127.0.0.1:' + str(self.server.server_port)

    def do_GET(self):
        if not self.trusted_host():
            return self.reply(403, {'error': 'Invalid Host'})
        path = urlsplit(self.path).path
        try:
            if path in ('/api/session', '/api/comments', '/review-data.js'):
                data, _ = self.server.data()
                if path == '/api/session':
                    return self.reply(200, dict(source_sha256=data['source_sha256'], csrf_token=self.server.token))
                if path == '/api/comments':
                    return self.reply(200, {'comments': data['comments']})
                raw = self.server.file('review-data.js').read_text(encoding='utf-8')
                match = re.fullmatch(r'\s*window\.RR_REVIEW\s*=\s*(\{.*\})\s*;?\s*', raw, re.S)
                if not match:
                    raise ValueError('Unsupported review-data.js format')
                payload = json.loads(match.group(1))
                if payload.get('source_sha256') != data['source_sha256']:
                    raise ValueError('Review payload source hash mismatch')
                payload['comments'] = data['comments']
                for paragraph in payload.get('paragraphs', []):
                    paragraph['html'] = self.server.map_images(paragraph['html'])
                encoded = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
                return self.reply(200, ('window.RR_REVIEW = ' + encoded + ';\n').encode(), 'text/javascript; charset=utf-8')
            if path.startswith('/media/') and path[7:] in self.server.media:
                media = self.server.media[path[7:]]
                if media.resolve() != media or media.is_symlink():
                    return self.reply(404, {'error': 'Not found'})
                return self.reply(200, media.read_bytes(), mimetypes.guess_type(media.name)[0])
            name = 'room.html' if path == '/' else path.removeprefix('/')
            if name in REPORTS:
                payload = self.server.file(name).read_bytes()
                if name == 'room.html':
                    page = (ASSETS / 'review.html').read_text(encoding='utf-8').replace('@@ASSETS@@', '/assets')
                    page = re.sub(r'((?:src|href)=["\'])[^"\']*/(review\.css|review\.js|human-feedbox\.js)(\?[^"\']*)?(["\'])',
                                  r'\1/assets/\2\3\4', page)
                    payload = page.encode()
                return self.reply(200, payload, (mimetypes.guess_type(name)[0] or 'text/plain') + '; charset=utf-8')
            if path.startswith('/assets/') and path[8:] in ASSET_NAMES:
                asset = ASSETS / path[8:]
                return self.reply(200, asset.read_bytes(), (mimetypes.guess_type(asset.name)[0] or 'text/plain') + '; charset=utf-8')
            self.reply(404, {'error': 'Not found'})
        except FileNotFoundError:
            self.reply(404, {'error': 'Not found'})
        except (ValueError, KeyError):
            self.reply(409, {'error': 'Review files are invalid or source has changed'})

    def do_POST(self):
        if not self.trusted_host() or self.headers.get('Origin') != self.server.origin or not secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), self.server.token):
            return self.reply(403, {'error': 'Invalid request origin or CSRF token'})
        if urlsplit(self.path).path != '/api/feedback':
            return self.reply(404, {'error': 'Not found'})
        if self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'Expected application/json'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if self.headers.get('Transfer-Encoding') or not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': 'Invalid body length'})
            self.connection.settimeout(5)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Expected object')
            comment = self.server.save_feedback(body)
            self.reply(200, {'comment': comment})
        except (ValueError, KeyError, UnicodeError) as exc:
            self.reply(409, {'error': str(exc)})
        except OSError:
            self.reply(500, {'error': 'Unable to persist feedback'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_dir', type=Path)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--ready-file', type=Path)
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    with PreviewServer(args.run_dir, args.port) as server:
        ready = dict(url=server.origin + '/', pid=os.getpid())
        if args.ready_file:
            atomic_json(args.ready_file, ready)
        print(json.dumps(ready), flush=True)
        if args.open_browser:
            webbrowser.open(ready['url'])
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
