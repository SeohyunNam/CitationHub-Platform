"""Second OpenAlex pass: look up, one by one, the DOIs that the batch filter missed.

Usage: python -I audit_openalex_retry.py <out_dir>
Reads and updates <out_dir>/openalex_audit.csv (adds column 'pass') and rewrites
<out_dir>/openalex_summary.json. Semantic Scholar paper IDs (40 hex characters,
used by IDCite for citing papers without a DOI) cannot be looked up by DOI and are
marked 'citing_no_doi' for the Semantic Scholar check instead.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

import pandas as pd

HEADERS = {"User-Agent": "citationhub-ground-truth-audit/1.0"}
HEX40 = re.compile(r"^[0-9a-f]{40}$")


def work(doi: str, fields: str):
    url = f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi, safe='/')}?select={fields}"
    for k in range(4):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (k + 1))
        except Exception:  # noqa: BLE001
            time.sleep(2 * (k + 1))
    return None


def main():
    out = Path(sys.argv[1])
    df = pd.read_csv(out / "openalex_audit.csv", dtype=str).fillna("")
    df["pass"] = "batch"
    todo = df[df["verdict"].isin(["citing_not_found", "cited_not_found", "not_in_references", "no_reference_list"])]
    cache = {}
    for i, r in todo.iterrows():
        if HEX40.match(r["citing_doi"]):
            df.at[i, "verdict"] = "citing_no_doi"
            continue
        if r["citing_doi"] not in cache:
            cache[r["citing_doi"]] = work(r["citing_doi"], "id,referenced_works"); time.sleep(0.12)
        if r["cited_doi"] not in cache:
            cache[r["cited_doi"]] = work(r["cited_doi"], "id"); time.sleep(0.12)
        c, t = cache[r["citing_doi"]], cache[r["cited_doi"]]
        if c is None:
            v = "citing_not_found"
        elif t is None:
            v = "cited_not_found"
        elif not c.get("referenced_works"):
            v = "no_reference_list"
        elif t["id"] in c["referenced_works"]:
            v = "confirmed"
        else:
            v = "not_in_references"
        df.at[i, "verdict"] = v
        df.at[i, "pass"] = "single"
        df.at[i, "citing_openalex"] = c["id"] if c else ""
        df.at[i, "cited_openalex"] = t["id"] if t else ""
        df.at[i, "n_references"] = str(len(c.get("referenced_works") or [])) if c else "0"
    df.to_csv(out / "openalex_audit.csv", index=False, encoding="utf-8")
    counts = Counter(df["verdict"])
    unverifiable = counts["citing_not_found"] + counts["cited_not_found"] + counts["no_reference_list"] + counts["citing_no_doi"]
    checkable = len(df) - unverifiable
    summary = {
        "events": len(df), "verdicts": dict(counts), "checkable_events": checkable,
        "confirmed_share_of_all": round(counts["confirmed"] / len(df), 4),
        "confirmed_share_of_checkable": round(counts["confirmed"] / checkable, 4),
        "date": time.strftime("%Y-%m-%d"),
        "source": "OpenAlex API (api.openalex.org), referenced_works of the citing paper; batch DOI filter, then single DOI lookups",
    }
    (out / "openalex_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
