"""Verify that a deployed CitationHub Citation search reproduces the reference rankings
and measure its response time.

For each of the 1,975 test events, the script calls the live service
  GET {API}/api/citation-search/test/queries/{idx}?condition=C2
reads the rank of the observed cited paper under C1, C2 and C3 that the service returns,
and compares it with the reference ranks
(reference_ranks.csv: citation_event_id, rank_C1, rank_C2, rank_C3). Calls are made one at a time so that the
response times are not affected by concurrent requests. Every attempt is logged,
including failed ones, so that failures and retries are reported, not hidden.

Usage: python -I verify_service.py <API> <reference_ranks.csv> <out_dir> [start_idx] [end_idx]
  With start_idx > 0, rows already in <out_dir>/service_ranks.csv are kept and the run resumes.
Outputs: <out_dir>/service_ranks.csv, <out_dir>/service_attempts.csv, <out_dir>/service_summary.json
"""
import csv
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

API, RANKS, OUT = sys.argv[1].rstrip("/"), Path(sys.argv[2]), Path(sys.argv[3])
START = int(sys.argv[4]) if len(sys.argv) > 4 else 0
END = int(sys.argv[5]) if len(sys.argv) > 5 else None
OUT.mkdir(parents=True, exist_ok=True)
HEADERS = {"User-Agent": "citationhub-service-check/1.0"}
CONDS = ["C1", "C2", "C3"]
ATTEMPTS = OUT / "service_attempts.csv"


def log_attempt(idx, ok, seconds, error=""):
    new = not ATTEMPTS.exists()
    with ATTEMPTS.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["time", "idx", "ok", "seconds", "error"])
        w.writerow([time.strftime("%Y-%m-%d %H:%M:%S"), idx, ok, round(seconds, 3), error])


def get(url, idx):
    for k in range(6):
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            dt = time.perf_counter() - t0
            log_attempt(idx, True, dt)
            return json.loads(body.decode("utf-8")), dt
        except Exception as e:  # noqa: BLE001
            log_attempt(idx, False, time.perf_counter() - t0, f"{type(e).__name__}: {e}"[:200])
            if k == 5:
                raise
            time.sleep(3 * (k + 1))


def write_rows(rows):
    with (OUT / "service_ranks.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


def main():
    reference = {}
    with RANKS.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            reference[row["citation_event_id"]] = {c: int(row[f"rank_{c}"]) for c in CONDS}

    rows = []
    if START > 0:
        with (OUT / "service_ranks.csv").open(encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f) if int(r["idx"]) < START]

    meta, _ = get(f"{API}/api/citation-search/test/meta", -1)
    n = meta["n_queries"]
    wall0 = time.perf_counter()
    for idx in range(START, END if END is not None else n):
        d, dt = get(f"{API}/api/citation-search/test/queries/{idx}?condition=C2", idx)
        ev = d["query"]["citation_event_id"]
        svc = {c: int(d["cited"]["ranks"][c]) for c in CONDS}
        ref = reference.get(ev)
        same = ref is not None and all(svc[c] == ref[c] for c in CONDS)
        rows.append({"idx": idx, "citation_event_id": ev,
                     **{f"service_{c}": svc[c] for c in CONDS},
                     **{f"reference_{c}": (ref or {}).get(c, "") for c in CONDS},
                     "identical": same, "seconds": round(dt, 3)})
        if (idx + 1) % 100 == 0:
            el = (time.perf_counter() - wall0) / 60
            print(f"  {idx + 1}/{n}  last {dt:.2f}s  wall {el:.1f} min", file=sys.stderr, flush=True)
            write_rows(rows)
    write_rows(rows)

    ts = sorted(float(r["seconds"]) for r in rows)
    ident = lambda r: str(r["identical"]) == "True"  # noqa: E731
    with ATTEMPTS.open(encoding="utf-8") as f:
        att = [a for a in csv.DictReader(f) if int(a["idx"]) >= 0]
    failed = [a for a in att if a["ok"] == "False"]
    summary = {
        "api": API, "date": time.strftime("%Y-%m-%d"),
        "matrix_sha256_reported_by_service": meta.get("matrix_sha256"),
        "events": n, "events_checked": len(rows),
        "identical_all_three_conditions": sum(ident(r) for r in rows),
        "identical_per_condition": {c: sum(1 for r in rows if str(r[f"service_{c}"]) == str(r[f"reference_{c}"])) for c in CONDS},
        "response_time_seconds_successful_requests": {
            "median": round(statistics.median(ts), 3), "mean": round(statistics.mean(ts), 3),
            "p90": round(ts[int(0.9 * (len(ts) - 1))], 3), "p95": round(ts[int(0.95 * (len(ts) - 1))], 3),
            "max": round(ts[-1], 3),
        },
        "attempts_logged_since_resume": len(att), "failed_attempts_logged_since_resume": len(failed),
        "failure_examples": [a["error"] for a in failed[:5]],
        "resumed_from_idx": START,
        "note": "One request at a time to the deployed service; times include network latency. Attempt logging started at the resume point.",
    }
    (OUT / "service_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
