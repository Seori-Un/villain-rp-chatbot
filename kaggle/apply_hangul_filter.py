"""Patch rag-chatbot _filter_text so Korean PDF text is kept."""
from pathlib import Path
import re

TARGET = Path("rag_chatbot/core/ingestion/ingestion.py")
candidates = [
    Path("/kaggle/working/rag-chatbot") / TARGET,
    Path(".") / TARGET,
    Path("/tmp/rag-chatbot") / TARGET,
]
path = next((p for p in candidates if p.exists()), None)
if path is None:
    raise SystemExit(f"Cannot find {TARGET}")

text = path.read_text(encoding="utf-8")
already = any(("AC00" in line or "가-힣" in line) and "pattern" in line for line in text.splitlines())
if already:
    print("already patched:", path)
else:
    new_assign = (
        "pattern = r'[a-zA-Z0-9 "
        "\u00C0-\u01B0\u1EA0-\u1EF9"
        "\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3"
        "`~!@#$%^&*()_\-+=\[\]{}|\\;:'\",.<>/?·…‘’“”～、。？！]+'"
    )
    # Prefer writing unicode escapes into the .py file for readability across editors
    new_assign = (
        "pattern = r'[a-zA-Z0-9 "
        + r"\u00C0-\u01B0\u1EA0-\u1EF9"
        + r"\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3"
        + r"`~!@#$%^&*()_\-+=\[\]{}|\\;:\'\",.<>/?·…‘’“”～、。？！]+'"
    )

    def repl(_m: re.Match) -> str:
        return new_assign

    new, n = re.subn(r"pattern = r'\[[^\n]+\]\+'", repl, text, count=1)
    if n != 1:
        raise SystemExit(f"pattern assignment not found (n={n})")
    path.write_text(new, encoding="utf-8")
    print("patched:", path)

pattern = r"[a-zA-Z0-9 \u00C0-\u01B0\u1EA0-\u1EF9\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3`~!@#$%^&*()_\-+=\[\]{}|\\;:'\",.<>/?·…‘’“”～、。？！]+"
sample = "안녕 Hello thế giới 123"
filtered = " ".join(re.findall(pattern, sample))
print("self-test:", filtered)
assert "안녕" in filtered and "Hello" in filtered
old_pat = r"[a-zA-Z0-9 \u00C0-\u01B0\u1EA0-\u1EF9`~!@#$%^&*()_\-+=\[\]{}|\\;:'\",.<>/?]+"
assert "안녕" not in " ".join(re.findall(old_pat, sample))
print("ok")
