"""Check evaluation events against Semantic Scholar.

Two checks, using the reference list (with citation contexts) of each citing paper
from the Semantic Scholar Graph API:
  1. citation: does the citing paper's reference list contain the answer paper (by DOI)?
     Run for every event that OpenAlex could not confirm, and for a random sample.
  2. context:  does one of the citation contexts that Semantic Scholar records for this
     citing -> cited pair match the event's citation context?
     Reported for a random sample of events (fixed seed), so the share is unbiased.

Usage: python -I audit_semanticscholar.py <test_queries_1975.parquet> <openalex_audit.csv> <out_dir> [sample_size]
Outputs: <out_dir>/semanticscholar_audit.csv, <out_dir>/semanticscholar_summary.json
Only public paper identifiers are sent; no personal data is included in requests.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

HEADERS = {"User-Agent": "citationhub-ground-truth-audit/1.0"}
API = "https://api.semanticscholar.org/graph/v1/paper/{pid}/references?fields=externalIds,contexts&limit=1000"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
SEED = 42


def strip(prefix_id: str) -> str:
    return prefix_id.split(":", 1)[1].strip().lower()


def norm(t: str) -> str:
    return " ".join(re.sub(r"[^0-9a-z]+", " ", (t or "").lower()).split())


def context_match(event_ctx: str, s2_ctxs: list[str]) -> bool:
    e = norm(event_ctx)
    if not e:
        return False
    et = set(e.split())
    for c in s2_ctxs:
        n = norm(c)
        if len(n) < 15:
            continue
        if n in e or e in n:
            return True
        ct = set(n.split())
        if ct and len(ct & et) / len(ct) >= 0.9:
            return True
    return False


def references(pid: str):
    """List of {'doi': str, 'contexts': [...]} or None if the paper is unknown."""
    url = API.format(pid=urllib.parse.quote(pid, safe=":/"))
    wait = 3.0
    for _ in range(8):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            refs = []
            for item in data.get("data") or []:
                cp = item.get("citedPaper") or {}
                doi = ((cp.get("externalIds") or {}).get("DOI") or "").lower()
                refs.append({"doi": doi, "contexts": item.get("contexts") or []})
            return refs
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(wait); wait = min(wait * 2, 60)
        except Exception:  # noqa: BLE001
            time.sleep(wait); wait = min(wait * 2, 60)
    return "error"


def main():
    q = pd.read_parquet(sys.argv[1])
    oa = pd.read_csv(sys.argv[2], dtype=str).set_index("citation_event_id")
    out = Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
    k = int(sys.argv[4]) if len(sys.argv) > 4 else 300

    q["citing"] = q["citing_paper_id"].map(strip)
    q["cited"] = q["target_seed_id"].map(strip)
    q["openalex_verdict"] = q["citation_event_id"].map(oa["verdict"])
    rng = np.random.default_rng(SEED)
    sample_idx = set(rng.choice(len(q), size=k, replace=False).tolist())
    q["in_sample"] = [i in sample_idx for i in range(len(q))]
    todo = q[(q["openalex_verdict"] != "confirmed") | q["in_sample"]]
    print(f"{len(todo)} events, {todo['citing'].nunique()} citing papers", file=sys.stderr)

    cache, rows = {}, []
    for n, r in enumerate(todo.itertuples(), 1):
        pid = r.citing if HEX40.match(r.citing) else f"DOI:{r.citing}"
        if pid not in cache:
            cache[pid] = references(pid)
            time.sleep(1.1)
        refs = cache[pid]
        if refs is None:
            cit, ctx = "citing_not_found", None
        elif refs == "error":
            cit, ctx = "api_error", None
        elif not refs:
            cit, ctx = "no_reference_list", None
        else:
            hit = [x for x in refs if x["doi"] == r.cited]
            if hit:
                cit = "confirmed"
                ctxs = [c for x in hit for c in x["contexts"]]
                ctx = context_match(r.context_text, ctxs) if ctxs else "no_contexts"
            else:
                cit, ctx = "not_in_references", None
        rows.append({"citation_event_id": r.citation_event_id, "intent": r.intent,
                     "in_random_sample": r.in_sample, "openalex_verdict": r.openalex_verdict,
                     "s2_citation": cit, "s2_context_match": ctx})
        if n % 25 == 0:
            print(f"  {n}/{len(todo)}", file=sys.stderr)
            pd.DataFrame(rows).to_csv(out / "semanticscholar_audit.csv", index=False, encoding="utf-8")

    df = pd.DataFrame(rows)
    df.to_csv(out / "semanticscholar_audit.csv", index=False, encoding="utf-8")
    s = df[df["in_random_sample"]]
    s_ctx = s[s["s2_citation"] == "confirmed"]["s2_context_match"].astype(str)
    rest = df[df["openalex_verdict"] != "confirmed"]
    summary = {
        "random_sample": {
            "size": int(len(s)), "seed": SEED,
            "s2_citation": dict(Counter(s["s2_citation"])),
            "context_check_among_confirmed": dict(Counter(s_ctx)),
        },
        "events_not_confirmed_by_openalex": {
            "size": int(len(rest)),
            "s2_citation": dict(Counter(rest["s2_citation"])),
        },
        "date": time.strftime("%Y-%m-%d"),
        "source": "Semantic Scholar Graph API, /paper/{id}/references (externalIds, contexts)",
    }
    (out / "semanticscholar_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
