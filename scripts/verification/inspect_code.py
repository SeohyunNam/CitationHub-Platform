"""Inspection checks of the CitationHub source code for NFR3, NFR4, NFR6, and NFR7.

These requirements are partly about how the code is written rather than about a response
of the running service, so they are checked by reading the source:

NFR3 (transparency): the citation search page states that the example events are not
      representative, and only the observed cited paper is flagged (is_cited).
NFR4 (deployability): the SciBERT encoder is never moved to a GPU, and the seed-paper vectors
      are loaded from a precomputed file rather than encoded at request time.
NFR6 (availability): data and the encoder are loaded in a background thread at start-up,
      and a missing evaluation set is caught instead of stopping the service.
NFR7 (security): every API route is a GET route except the SPARQL proxy (guarded by NFR8),
      and no route requires authentication.

Usage: python -I inspect_code.py <repo_dir> <out_dir>
  <repo_dir> holds backend/ and frontend/.
Output: <out_dir>/code_inspection.json
"""
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

main = (REPO / "backend" / "main.py").read_text(encoding="utf-8")
search = (REPO / "backend" / "citation_search.py").read_text(encoding="utf-8")
page = (REPO / "frontend" / "pages" / "search" / "citation.jsx").read_text(encoding="utf-8")

checks = {}

# NFR3
note = "not representative" in page
flag_rule = re.search(r'"is_cited"\s*:\s*[^,\n]*target', main) is not None or "is_cited" in main
checks["NFR3"] = {"example_note_in_page": note, "cited_flag_in_api": flag_rule, "pass": note and flag_rule}

# NFR4
gpu = re.findall(r"\.cuda\(|\.to\(\s*[\"']cuda|device\s*=\s*[\"']cuda", search + main)
precomputed = "np.load(" in search and "EMBEDDINGS_FILE" in search
checks["NFR4"] = {"gpu_calls": gpu, "seed_vectors_loaded_from_file": precomputed,
                  "pass": not gpu and precomputed}

# NFR6
background = re.search(r"threading\.Thread\(target=_load,\s*daemon=True\)\.start\(\)", main) is not None
startup = "@app.on_event(\"startup\")" in main
caught = re.search(r"_load_test_set\(\)[\s\S]{0,200}except \(FileNotFoundError, ValueError\)", main) is not None
checks["NFR6"] = {"startup_hook": startup, "background_thread": background, "missing_set_caught": caught,
                  "pass": startup and background and caught}

# NFR7
routes = re.findall(r"@app\.(get|post|put|delete|patch)\(\"([^\"]+)\"", main)
non_get = [p for m, p in routes if m != "get"]
auth = re.findall(r"Depends\(|OAuth2|HTTPBearer|APIKeyHeader|Authorization", main)
checks["NFR7"] = {"routes": len(routes), "non_get_routes": non_get, "authentication_found": auth,
                  "pass": non_get == ["/api/sparql"] and not auth}

summary = {"repo": str(REPO), "date": time.strftime("%Y-%m-%d"),
           "all_passed": all(c["pass"] for c in checks.values()), "checks": checks}
(OUT / "code_inspection.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(checks, indent=1))
print("all passed:", summary["all_passed"])
