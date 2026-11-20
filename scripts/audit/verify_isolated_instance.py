"""Check NFR6 (availability) and NFR8 (safe query access) on a separate CitationHub instance.

Start the instance without the evaluation set, and with QLEVER_ENDPOINT set to a closed local
port, so that any query the SPARQL proxy forwarded would fail with a gateway error instead of
reaching an engine. For example (Windows, cmd):

  set CITATIONHUB_DATA_DIR=<data dir without thesis_eval/>
  set QLEVER_ENDPOINT=http://127.0.0.1:9
  python -m uvicorn main:app --app-dir backend --port 8010

NFR6: citation search reports that the evaluation set is missing, while search, overview,
      paper detail, and the map keep responding.
NFR8: INSERT, DELETE, and DROP queries, an update hidden behind a comment, and a query over
      8,000 characters are rejected by the proxy (HTTP 400) before reaching the engine; a
      read-only SELECT query is forwarded (and fails only because the engine port is closed).

The script refuses to run against a host other than localhost, so that modifying queries are
never sent to a deployed service.

Usage: python -I verify_isolated_instance.py <API> <out_dir>
Output: <out_dir>/isolated_instance_check.json
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = sys.argv[1].rstrip("/")
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
HEADERS = {"User-Agent": "citationhub-isolated-check/1.0"}

host = urllib.parse.urlparse(API).hostname
if host not in ("localhost", "127.0.0.1", "::1"):
    raise SystemExit(f"Refusing to run against {host}: this script sends modifying SPARQL queries "
                     "and must only be used on a separate local instance.")


def call(path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {**HEADERS, **({"Content-Type": "application/json"} if data else {})}
    req = urllib.request.Request(API + path, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None


checks = {}

# ---------------------------------------------------------------- NFR6
meta_status, meta = call("/api/citation-search/test/meta")
ex_status, ex = call("/api/citation-search/test/examples")
others = {}
st, overview = call("/api/overview")
others["overview"] = st
st, search = call("/api/search?" + urllib.parse.urlencode({"q": "stem cells", "limit": 1}))
others["search"] = st
paper_id = (search or {}).get("results", [{}])[0].get("seed_paper_id") if st == 200 else None
if paper_id:
    others["paper_detail"] = call("/api/papers/" + urllib.parse.quote(paper_id, safe=""))[0]
others["map"] = call("/api/geo")[0]
checks["NFR6"] = {
    "evaluation_set_available": (meta or {}).get("available"),
    "citation_search_message": (meta or {}).get("error") or (ex or {}).get("detail"),
    "examples_status": ex_status,
    "other_views_status": others,
    "pass": (meta or {}).get("available") is False and ex_status >= 400
    and all(v == 200 for v in others.values()) and "paper_detail" in others,
}

# ---------------------------------------------------------------- NFR8
modifying = {
    "insert": "INSERT DATA { <http://example.org/s> <http://example.org/p> \"x\" }",
    "delete": "DELETE WHERE { ?s ?p ?o }",
    "drop": "DROP ALL",
    "update_behind_comment": "# SELECT * WHERE { ?s ?p ?o }\nDELETE WHERE { ?s ?p ?o }",
    "too_long": "SELECT * WHERE { ?s ?p ?o } #" + "x" * 8100,
}
rejected = {}
for name, text in modifying.items():
    st, body = call("/api/sparql", {"query": text})
    rejected[name] = {"status": st, "message": (body or {}).get("detail")}
st, body = call("/api/sparql", {"query": "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }"})
control = {"status": st, "message": (body or {}).get("detail")}
checks["NFR8"] = {
    "modifying_or_oversized": rejected,
    "read_only_select_forwarded": control,
    "pass": all(v["status"] == 400 for v in rejected.values()) and control["status"] != 400,
}

summary = {"api": API, "date": time.strftime("%Y-%m-%d"),
           "all_passed": all(c["pass"] for c in checks.values()), "checks": checks}
(OUT / "isolated_instance_check.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False),
                                                   encoding="utf-8")
print(json.dumps(checks, indent=1, ensure_ascii=False))
print("all passed:", summary["all_passed"])
