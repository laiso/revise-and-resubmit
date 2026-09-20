"""Explicit language helpers; Japanese lengths are characters, never word proxies."""
import re


def add_language(parser):
    parser.add_argument("--lang", choices=("en", "ja"), default="en")


def count(text, lang="en"):
    return len(re.sub(r"\s", "", text)) if lang == "ja" else len(text.split())


def unit(lang):
    return "characters" if lang == "ja" else "words"


def ja_sentences(text):
    # Keep closing quotation marks with the sentence. ASCII decimals stay intact.
    return [m.group().strip() for m in re.finditer(
        r'.+?(?:[。！？!?]+[」』”\"]*|[.](?=\s|$)|$)', text, re.S)
        if m.group().strip()]


def visible_text(text):
    text = re.sub(r"```.*?```|~~~.*?~~~", " ", text, flags=re.S)
    text = re.sub(r"^\s*\[[^\]]+\]:\s*\S+.*$", "", text, flags=re.M)
    text = re.sub(r"\[([^\]]+)\]\([^\s)]*(?:\([^)]*\)[^)]*)*\)", r"\1", text)
    text = re.sub(r"https?://[^\s<>）「」]+", " ", text)
    return text


def ja_numbers(text):
    return re.findall(
        r"[A-Za-z][A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]*|[¥￥$]?\d+(?:[.,]\d+)*(?:[%％]|万|億|[A-Za-z]+)?",
        visible_text(text))


def ja_chunks(text, target=300, maximum=700):
    out, buf = [], ""
    for para in re.split(r"\n\s*\n", text):
        if not para.strip():
            continue
        # Bound unpunctuated text too, without deleting characters or inserting spaces.
        for sentence in ja_sentences(para.strip()):
            while len(sentence) > maximum:
                if buf:
                    out.append(buf); buf = ""
                out.append(sentence[:target]); sentence = sentence[target:]
            if buf and len(buf) + len(sentence) + 2 > maximum:
                out.append(buf); buf = ""
            buf += sentence
            if len(buf) >= target:
                out.append(buf); buf = ""
        if buf:
            buf += "\n\n"
    if buf.strip():
        out.append(buf.strip())
    return out
