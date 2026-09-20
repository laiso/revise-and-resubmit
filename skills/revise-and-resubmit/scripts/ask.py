#!/usr/bin/env python3
# Derived from awesome-llm-apps/agent_skills/first-reader (Apache-2.0).
# Modified by laiso: incremental understanding workflow; removed legacy review paths.
# See THIRD_PARTY_NOTICES.md and licenses/first-reader-Apache-2.0.txt in the skill directory.
"""読書後の質問と、その読者の記録だけを新しいエージェントに渡す。

python3 ask.py <run-dir> <reader|all> "<question>"
原稿全文を含めない。ログにない経験は補わず、未記録と答える。
"""
import json
import sys
from pathlib import Path


def bundle(run, name, question):
    d = Path(run) / name
    if not (d / "state.json").exists():
        return None
    state = json.loads((d / "state.json").read_text())
    entries = [json.loads(l) for l in (d / "log.jsonl").read_text().splitlines() if l.strip()]
    log = "\n".join(f"[passage {e['chunk']}] {'QUIT ' if e.get('quit') else ''}{e['entry']}" for e in entries)
    how = ("stopped at passage %s of %s" % (state["quit_at"], len(state["chunks"]))) if state.get("quit_at") \
        else "finished all %s passages" % len(state["chunks"])
    return (f"You are {state['persona']}. In the recorded session you read a piece one passage at a time and {how}. "
            f"Use only the following recorded observations "
            f"from that session:\n\n{log}\n\nThe author asks you: {question}\n\n"
            f"Answer as yourself, in under 150 words, grounded only in what you noted at the time. Quote your own "
            f"notes where they answer it. Do not invent details of the text you did not note. If the log does not "
            f"support an answer, say 'I can't say; I didn't note it at the time.' Never suggest rewrites; say what "
            f"happened to you and what would have had to be true for it to go differently.")


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    run, who, question = sys.argv[1], sys.argv[2], sys.argv[3]
    names = [who]
    if who == "all":
        names = sorted(p.name for p in Path(run).iterdir() if (p / "state.json").exists())
    out = []
    for n in names:
        b = bundle(run, n, question)
        if b is None:
            sys.exit(f"no reader '{n}' under {run}")
        out.append(f"===== reader: {n} =====\n{b}")
    print("\n\n".join(out))


if __name__ == "__main__":
    main()
