"""Regression guard for the Krillocity canonical-merge consumption path.

The userscript may only use a VERBATIM bank question as a fallback lookup key.
Log-only / non-bank wordings are review data: applying them as query rewrites
would be an alias pinned into matching (injection/DECISIONS.md).
"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "data" / "krillocity_canonical.json"
SCRIPT = ROOT / "injection" / "krillion-autofill.user.js"
DB = ROOT / "data" / "krillion_search.db"


def check(cond, msg):
    assert cond, msg


def test_krillocity_canonical() -> str:
    if not ARTIFACT.exists():
        return "SKIP: canonical artifact not built"
    art = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    src = SCRIPT.read_text(encoding="utf-8", errors="replace")

    # Source-level guards: the unsafe original behaviour must be gone.
    check("variant.exact_bank !== true" in src,
          "userscript must exclude non-bank variants from lookup keys")
    check("variant.log_only === true" in src,
          "userscript must exclude log-only variants from lookup keys")
    check("text !== target" in src,
          "userscript must only key the target bank wording")
    check("canonical.target" in src and "return canonical.canonical" not in src,
          "userscript must never rewrite to a merge canonical")
    check("@version      1.2.0" in src,
          "userscript version should be 1.2.0 for the race pool fix")

    # Data-level guards against the artifact.
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    banks = {r[0] for r in conn.execute("SELECT question FROM search_answers")}
    conn.close()
    check(art.get("policy", {}).get("aliases_applied_to_matching") is False,
          "artifact must declare aliases log-only")

    safe_keys = 0
    unsafe_keys = 0
    for group in art.get("groups", []):
        bank_questions = group.get("bank_questions") or []
        if not bank_questions:
            continue
        target = bank_questions[0]
        check(target in banks, f"target is not a verbatim Search DB bank: {target}")
        for v in group.get("variants") or []:
            eligible = (v.get("exact_bank") is True and v.get("log_only") is not True
                        and v.get("text") == target)
            if eligible:
                safe_keys += 1
                check(v["text"] in banks, f"eligible key not a bank: {v['text']}")
            else:
                unsafe_keys += 1
    check(safe_keys > 0, "no eligible verbatim-bank lookup keys found")
    return (f"canonical keys verbatim-bank={safe_keys}, excluded(log-only/non-bank)="
            f"{unsafe_keys}, no merge-canonical rewrite, version=1.2.0")


if __name__ == "__main__":
    print(test_krillocity_canonical())
