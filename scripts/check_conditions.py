"""Print Citation search scores and ranks under the C1 / C2 / C3 conditions.

Runs against a running backend (default http://127.0.0.1:8000; override with
CITATIONHUB_API). Uses only the Python standard library.

  python3 check_conditions.py example        # GOT-10k example, ordered by C2 (the site's ranking)
  python3 check_conditions.py example C3     # same example, ordered by C3
  python3 check_conditions.py replicate 30   # MRR / Hits@k / nDCG@10 over 30 events per intent

`example` shows, for a real IDCite citation event, where the paper it actually cites
ranks under each condition, and the C1/C2/C3 rank and score of every listed result.
`replicate` re-runs the controlled citation-recovery test (each cited paper against
99 same-field papers) on a fixed sample of IDCite citation events.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = os.environ.get("CITATIONHUB_API", "http://127.0.0.1:8000").rstrip("/") + "/api/citation-search"


def show(v):
    return "-" if v is None else str(v)


def example(condition="C2"):
    params = {
        "title": "Context-Aware Token Pruning and Discriminative Selective Attention for Transformer Tracking",
        "context": "Following the GOT-10k protocol [44], we train the model using only the GOT-10k "
                   "training split and evaluate its performance on the corresponding test set.",
        "intents": "uses",
        "field": "Computer Science",
        "target": "seed:10.1109/tpami.2019.2957464",
        "limit": 15,
        "condition": condition,
    }
    d = json.load(urllib.request.urlopen(API + "?" + urllib.parse.urlencode(params), timeout=600))
    print("ranked by:", d["query"]["condition"], "| candidates:", d["candidates"])
    t = d.get("target") or {}
    if t and not t.get("excluded"):
        print("actual cited paper:", t["title"][:70])
        print("  ranks :", t["ranks"])
        print("  scores:", t["scores"])
    print()
    print("%3s  %7s %7s %7s   %6s %6s %6s  %s" % ("#", "C1 rank", "C2 rank", "C3 rank", "C1", "C2", "C3", "title"))
    for r in d["results"]:
        rk, sc = r["ranks"], r["scores"]
        print("%3d  %7s %7s %7s   %6s %6s %6s  %s" % (
            r["rank"], show(rk["C1"]), show(rk["C2"]), show(rk["C3"]),
            show(sc["C1"]), show(sc["C2"]), show(sc["C3"]), r["title"][:55]))


def replicate(n=30):
    d = json.load(urllib.request.urlopen(API + "/replicate?n=%d" % n, timeout=900))
    print("queries:", d["n_queries"], "| candidates per query:", d["candidates"])
    print("%-6s %8s %8s %8s %8s %8s" % ("", "MRR", "Hits@1", "Hits@5", "Hits@10", "nDCG@10"))
    for c in ("C1", "C2", "C3"):
        m = d["overall"][c]
        print("%-6s %8.4f %8.4f %8.4f %8.4f %8.4f" % (c, m["mrr"], m["hits1"], m["hits5"], m["hits10"], m["ndcg10"]))
    print()
    print("MRR by intent")
    for r in d["by_intent"]:
        print("  %-13s n=%-4d C1=%.4f  C2=%.4f  C3=%.4f" % (r["intent"], r["n"], r["C1"], r["C2"], r["C3"]))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "example"
    if mode == "replicate":
        replicate(int(sys.argv[2]) if len(sys.argv) > 2 else 30)
    elif mode == "example":
        example(sys.argv[2].upper() if len(sys.argv) > 2 else "C2")
    else:
        sys.exit(__doc__)
