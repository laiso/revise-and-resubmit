"""Render the shared R&R redline viewer from source.md and annotations.json."""
import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re


def inline(text):
    # Escape first. Only explicit HTTP(S) links and inline code are supported.
    text = html.escape(text)
    text = re.sub(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', r'<a href="\2">\1</a>', text)
    return re.sub(r'`([^`]+)`', r'<code>\1</code>', text)


class InlineNodes(HTMLParser):
    def __init__(self, markup):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.feed(markup)

    def handle_starttag(self, tag, attrs):
        self.nodes.append(("tag", self.get_starttag_text()))

    def handle_endtag(self, tag):
        self.nodes.append(("tag", f"</{tag}>"))

    def handle_data(self, data):
        self.nodes.append(("text", data))


def highlight(markup, quotes):
    nodes = InlineNodes(markup).nodes
    text = "".join(value for kind, value in nodes if kind == "text")
    selected = [False] * len(text)
    for quote in sorted(quotes, key=lambda q: (-len(q), q)):
        visible = "".join(v for k, v in InlineNodes(inline(quote)).nodes if k == "text")
        start = text.find(visible)
        if visible and start >= 0:
            selected[start:start + len(visible)] = [True] * len(visible)
    output = []
    offset = 0
    for kind, value in nodes:
        if kind == "tag":
            output.append(value)
            continue
        active = False
        for index, char in enumerate(value):
            marked = selected[offset + index]
            if marked != active:
                output.append("<mark>" if marked else "</mark>")
                active = marked
            output.append(html.escape(char))
        if active:
            output.append("</mark>")
        offset += len(value)
    return "".join(output)


def render(run):
    run = Path(run).resolve()
    assets = Path(__file__).resolve().parents[1] / 'assets'
    source = (run / 'source.md').read_text()
    data = json.loads((run / 'annotations.json').read_text())
    actual = hashlib.sha256((run / 'source.md').read_bytes()).hexdigest()
    if data['source_sha256'] != actual:
        raise ValueError('source.md does not match annotation source hash')
    blocks = re.split(r'\n\s*\n', source.strip())
    title = blocks.pop(0).lstrip('# ')
    for c in data['comments']:
        if not 1 <= c['paragraph'] <= len(blocks):
            raise ValueError('Invalid paragraph anchor: ' + c['id'])
        if c.get('quote') and c['quote'] not in blocks[c['paragraph'] - 1]:
            raise ValueError('Quote mismatch: ' + c['id'])
    paragraphs = []
    for number, block in enumerate(blocks, 1):
        rendered = inline(block)
        quotes = {c['quote'] for c in data['comments'] if c['paragraph'] == number and c.get('quote')}
        rendered = highlight(rendered, quotes)
        paragraphs.append({'number': number, 'html': rendered})
    payload = dict(data, title=title, paragraphs=paragraphs)
    # A classic script works under file:// without fetch/CORS or a server.
    encoded = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    (run / 'review-data.js').write_text('window.RR_REVIEW = ' + encoded + ';\n')
    rel = Path(os.path.relpath(assets, run)).as_posix()
    page = (assets / 'review.html').read_text().replace('@@ASSETS@@', html.escape(rel, quote=True))
    # Content-versioned assets avoid mixing a new form with cached old handlers.
    for asset in ('review.css', 'review.js', 'human-feedbox.js'):
        version = hashlib.sha256((assets / asset).read_bytes()).hexdigest()[:12]
        page = page.replace('/' + asset + '"', '/' + asset + '?v=' + version + '"')
    version = hashlib.sha256((run / 'review-data.js').read_bytes()).hexdigest()[:12]
    page = page.replace('src="review-data.js"', 'src="review-data.js?v=' + version + '"')
    (run / 'room.html').write_text(page)
    return len(paragraphs), len(data['comments'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_dir')
    args = parser.parse_args()
    print('Rendered paragraphs/comments:', render(args.run_dir))
