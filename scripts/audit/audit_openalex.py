"""Check every evaluation answer against OpenAlex.

For each test citation event, the answer (target_seed_id) is the paper cited by the
citing paper (citing_paper_id). This script asks OpenAlex, an independent public
bibliographic database, whether the citing paper's reference list contains the
answer paper.

Usage:  python -I audit_openalex.py <test_queries_1975.parquet> <out_dir>

Outputs:
  <out_dir>/openalex_audit.csv      one row per event with the verdict
  <out_dir>/openalex_summary.json   counts per verdict

Verdicts:
  confirmed            the citing paper's OpenAlex reference list contains the answer
  not_in_references    both papers are in OpenAlex, but the reference list lacks the answer
  no_reference_list    the citing paper is in OpenAlex but has no reference list there
  citing_not_found     the citing DOI is not in OpenAlex
  cited_not_found      the answer DOI is not in OpenAlex
Only public DOIs are sent; no personal data is included in requests.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

import pandas as pd

API = "https://api.openalex.org/works"
HEADERS = {"User-Agent": "citationhub-ground-truth-audit/1.0"}
BATCH = 50


def strip(prefix_id: str) -> str:
    """'citing:10.x/abc' or 'seed:10.x/abc' -> '10.x/abc' (lower-case)."""
    return prefix_id.split(":", 1)[1].strip().lower()


def get(url: str, tries: int = 5) -> dict:
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — retry on network/rate errors
            if k == tries - 1:
                raise
            time.sleep(2 * (k + 1))
    return {}


def lookup(dois: list[str], with_refs: bool) -> dict[str, dict]:
    """DOI -> {'id': OpenAlex id, 'refs': set of OpenAlex ids or None}."""
    out = {}
    fields = "id,doi,referenced_works" if with_refs else "id,doi"
    for i in range(0, len(dois), BATCH):
        chunk = dois[i:i + BATCH]
        flt = "doi:" + "|".join(chunk)
        url = f"{API}?filter={urllib.parse.quote(flt, safe=':|/')}&select={fields}&per-page={BATCH}"
        data = get(url)
        for w in data.get("results", []):
            doi = (w.get("doi") or "").lower().replace("https://doi.org/", "")
            out[doi] = {"id": w["id"], "refs": set(w.get("referenced_works") or []) if with_refs else None}
        time.sleep(0.15)
        print(f"  {min(i + BATCH, len(dois))}/{len(dois)}", file=sys.stderr)
    return out


def main():
    q = pd.read_parquet(sys.argv[1])
    out_dir = Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
    q["citing_doi"] = q["citing_paper_id"].map(strip)
    q["cited_doi"] = q["target_seed_id"].map(strip)

    print("Looking up citing papers ...", file=sys.stderr)
    citing = lookup(sorted(set(q["citing_doi"])), with_refs=True)
    print("Looking up answer papers ...", file=sys.stderr)
    cited = lookup(sorted(set(q["cited_doi"])), with_refs=False)

    rows = []
    for r in q.itertuples():
        c, t = citing.get(r.citing_doi), cited.get(r.cited_doi)
        if c is None:
            v = "citing_not_found"
        elif t is None:
            v = "cited_not_found"
        elif not c["refs"]:
            v = "no_reference_list"
        elif t["id"] in c["refs"]:
            v = "confirmed"
        else:
            v = "not_in_references"
        rows.append({
            "citation_event_id": r.citation_event_id, "intent": r.intent,
            "citing_doi": r.citing_doi, "cited_doi": r.cited_doi,
            "citing_openalex": c["id"] if c else "", "cited_openalex": t["id"] if t else "",
            "n_references": len(c["refs"]) if c and c["refs"] else 0,
            "verdict": v,
        })
    df = pd.DataFrame(rows)
    df.to_csv(out_dir / "openalex_audit.csv", index=False, encoding="utf-8")
    counts = Counter(df["verdict"])
    checkable = len(df) - counts["citing_not_found"] - counts["cited_not_found"] - counts["no_reference_list"]
    summary = {
        "events": len(df),
        "verdicts": dict(counts),
        "checkable_events": checkable,
        "confirmed_share_of_all": round(counts["confirmed"] / len(df), 4),
        "confirmed_share_of_checkable": round(counts["confirmed"] / checkable, 4) if checkable else None,
        "date": time.strftime("%Y-%m-%d"),
        "source": "OpenAlex API (api.openalex.org), referenced_works of the citing paper",
    }
    (out_dir / "openalex_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
