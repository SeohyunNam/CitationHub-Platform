"""Check the Citation search requirements of a deployed CitationHub backend.

Each check sends GET requests only and records the evidence for one functional or
non-functional requirement: example events (FR2), title suggestions (FR2), intent and field
filters (FR3), partial versus full queries (FR1), the default condition (FR6), the ranks of
the cited paper (FR7), the result list (FR8), the citation contexts of candidates (FR9), the
event identifier and candidate CSV (FR10), the marking of the cited paper (NFR3), the data
configuration (NFR5), and HTTPS (NFR7). Every check also reports whether it passed.

Usage: python -I verify_requirements.py <API> <out_dir> [event_idx]
  <event_idx> is the test event used for the per-event checks (default 194).
Output: <out_dir>/requirements_check.json
"""
import csv
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API = sys.argv[1].rstrip("/")
OUT = Path(sys.argv[2])
IDX = int(sys.argv[3]) if len(sys.argv) > 3 else 194
OUT.mkdir(parents=True, exist_ok=True)
HEADERS = {"User-Agent": "citationhub-requirements-check/1.0"}


def get(path, raw=False):
    req = urllib.request.Request(API + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
        return body.decode("utf-8") if raw else json.loads(body)


def q(**params):
    return "/api/citation-search/test/queries?" + urllib.parse.urlencode(params)


checks = {}

# The event used for the per-event checks
event = get(f"/api/citation-search/test/queries/{IDX}")
query = event["query"]
title, context = query["title"], query["context"]

# FR1: part of the title and context does not identify the event exactly; the full text does
part_title = " ".join(title.split()[:4])
part_context = " ".join(context.split()[:3])
partial = get(q(title=part_title, context=part_context, limit=50))["results"]
full = get(q(title=title, context=context, limit=50))["results"]
exact = lambda rows: [r for r in rows if r["title"] == title and r["context"] == context]  # noqa: E731
checks["FR1"] = {
    "partial_text": [part_title, part_context],
    "partial_text_equal_to_event": any(r["title"] == part_title for r in partial),
    "full_text_exact_matches": len(exact(full)),
    "pass": len(exact(full)) == 1 and not any(r["title"] == part_title for r in partial),
}

# FR2: one example per intent; at most eight title suggestions for a three-character prefix
examples = get("/api/citation-search/test/examples")["results"]
intents = Counter(e["intent"] for e in examples)
prefix = title[:3]
suggestions = get(q(title=prefix, limit=8))
checks["FR2"] = {
    "examples": len(examples), "examples_per_intent": dict(intents),
    "suggestion_prefix": prefix, "suggested": len(suggestions["results"]),
    "matching": suggestions.get("total"),
    "pass": all(v == 1 for v in intents.values()) and len(suggestions["results"]) <= 8,
}

# FR3: filtering by intent and field
intent, field = "uses", query["field"]
filtered = get(q(intent=intent, field=field, limit=50))
rows = list(filtered["results"])
for page in range(2, (filtered.get("total_pages") or 1) + 1):
    rows += get(q(intent=intent, field=field, limit=50, page=page))["results"]
checks["FR3"] = {
    "intent": intent, "field": field, "total": filtered.get("total"), "checked": len(rows),
    "pass": bool(rows) and all(r["intent"] == intent and r["field"] == field for r in rows),
}

# FR4, FR5, FR6, FR7, FR8: the ranking of the event under the default condition
results = event.get("results", [])
checks["FR4"] = {"query_fields": sorted(k for k in ("title", "context", "intent") if query.get(k)),
                 "pass": all(query.get(k) for k in ("title", "context", "intent"))}
checks["FR5"] = {"candidates": event.get("candidates"), "pass": event.get("candidates") in (100, None)}
checks["FR6"] = {"default_condition": event.get("condition"), "pass": event.get("condition") == "C2"}
checks["FR7"] = {"cited_ranks": event["cited"]["ranks"],
                 "pass": all(c in event["cited"]["ranks"] for c in ("C1", "C2", "C3"))}
fields = ("title", "author", "journal", "year", "doi", "scores", "rank")
checks["FR8"] = {"listed": len(results), "fields_present": all(all(f in r for f in fields) for r in results),
                 "pass": len(results) == 10 and all(all(f in r for f in fields) for r in results)}

# FR9: per-intent counts and at most four citing papers, without the query's citing paper
citing = query.get("citing_paper_id")
per_candidate, own = [], 0
for r in results:
    contexts = r.get("evidence") or []
    if isinstance(contexts, dict):
        contexts = contexts.get("contexts", [])
    per_candidate.append(len(contexts))
    own += sum(1 for c in contexts if c.get("citing_paper_id") == citing)
checks["FR9"] = {
    "intent_counts_shown": all("intent_counts" in r for r in results),
    "max_citing_papers_per_candidate": max(per_candidate) if per_candidate else 0,
    "query_citing_paper_listed": own,
    "pass": all("intent_counts" in r for r in results) and max(per_candidate or [0]) <= 4 and own == 0,
}

# FR10, NFR3: event identifier, candidate CSV, and marking of the cited paper only
table = list(csv.DictReader(io.StringIO(get(f"/api/citation-search/test/queries/{IDX}/candidates.csv", raw=True))))
score_rank = all(f"{p}_{c}" in table[0] for p in ("score", "rank") for c in ("C1", "C2", "C3")) if table else False
checks["FR10"] = {"event_identifier": query.get("citation_event_id"), "csv_rows": len(table),
                  "scores_and_ranks": score_rank,
                  "pass": bool(query.get("citation_event_id")) and len(table) == 100 and score_rank}
marked_list = sum(1 for r in results if r.get("is_cited"))
marked_csv = sum(1 for r in table if r.get("is_cited_target") == "1")
checks["NFR3"] = {"marked_in_list": marked_list, "marked_in_csv": marked_csv,
                  "pass": marked_list <= 1 and marked_csv == 1}

# NFR5: the service reads local Parquet files, not a remote dataset
config = get("/api/debug")
checks["NFR5"] = {"remote_dataset": config.get("HF_REPO_ID"), "data_dir": config.get("DATA_DIR"),
                  "pass": config.get("HF_REPO_ID") in (None, "", "(not set)")}

# NFR7: served over HTTPS
checks["NFR7"] = {"https": API.startswith("https://"), "pass": API.startswith("https://")}

summary = {"api": API, "date": time.strftime("%Y-%m-%d"), "event_idx": IDX,
           "all_passed": all(c["pass"] for c in checks.values()), "checks": checks}
(OUT / "requirements_check.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({k: v["pass"] for k, v in checks.items()}, indent=1))
print("all passed:", summary["all_passed"])
