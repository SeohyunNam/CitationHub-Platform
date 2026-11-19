"""Name/year leakage check for the test set.

A query is flagged when its citation context contains the first-author surname of the
cited (target) paper or the target's publication year. The script reports C1/C2/C3 MRR
on the flagged and unflagged subsets with paired tests on the unflagged subset, and lists
unflagged events that are good illustrative examples.

Usage: python -I leakage_subset.py <eval_dir> <out_dir>
  <eval_dir> holds test_queries_1975.parquet, seed_index.parquet (both from
  extract_candidates.py) and reference_ranks.csv (citation_event_id, rank_C1, rank_C2, rank_C3).
Requires scipy.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import wilcoxon

SUP, OUT = Path(sys.argv[1]), Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

q = pd.read_parquet(SUP / "test_queries_1975.parquet")
seed = pd.read_parquet(SUP / "seed_index.parquet")
ranks = pd.read_csv(SUP / "reference_ranks.csv")


def fold(t):
    return unicodedata.normalize("NFKD", str(t)).encode("ascii", "ignore").decode().lower()


def surname(creator):
    c = str(creator or "").strip()
    if not c or c.lower() == "nan":
        return ""
    return c.split()[0].rstrip(",.")


seed["surname"] = seed["creator"].map(surname)
seed["year"] = pd.to_datetime(seed["cover_date"], errors="coerce").dt.year
m = q.merge(seed[["seed_paper_id", "surname", "year", "title", "creator", "field_id"]],
            left_on="target_seed_id", right_on="seed_paper_id", how="left")
m = m.merge(ranks, on="citation_event_id", how="left")


def has_name(row):
    s = fold(row["surname"])
    return bool(s) and len(s) > 1 and re.search(r"(?<![a-z])" + re.escape(s) + r"(?![a-z])", fold(row["context_text"])) is not None


def has_year(row):
    y = row["year"]
    return pd.notna(y) and re.search(r"(?<!\d)" + str(int(y)) + r"(?!\d)", str(row["context_text"])) is not None


m["name_in_context"] = m.apply(has_name, axis=1)
m["year_in_context"] = m.apply(has_year, axis=1)
m["leak"] = m["name_in_context"] | m["year_in_context"]


def mrr(d):
    return {c: round(float((1 / d[f"rank_{c}"]).mean()), 4) for c in ["C1", "C2", "C3"]}


def paired(d, a, b, B=10000, seed=42):
    x = (1 / d[f"rank_{b}"] - 1 / d[f"rank_{a}"]).to_numpy()
    rng = np.random.default_rng(seed)
    boots = rng.choice(x, size=(B, len(x)), replace=True).mean(axis=1)
    lo, hi = np.percentile(boots, [2.5, 97.5])
    p = wilcoxon(1 / d[f"rank_{b}"], 1 / d[f"rank_{a}"]).pvalue
    return {"delta": round(float(x.mean()), 4), "ci95": [round(float(lo), 4), round(float(hi), 4)], "wilcoxon_p": float(p)}


clean, leak = m[~m["leak"]], m[m["leak"]]
summary = {
    "queries": len(m),
    "flagged": {"any": int(m["leak"].sum()), "name": int(m["name_in_context"].sum()), "year": int(m["year_in_context"].sum())},
    "mrr_all": mrr(m), "mrr_flagged": mrr(leak), "mrr_unflagged": mrr(clean),
    "unflagged_C1_to_C2": paired(clean, "C1", "C2"), "unflagged_C2_to_C3": paired(clean, "C2", "C3"),
    "flagged_C1_to_C2": paired(leak, "C1", "C2"),
}
(OUT / "leakage_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
m[["citation_event_id", "intent", "surname", "year", "name_in_context", "year_in_context", "leak",
   "rank_C1", "rank_C2", "rank_C3"]].to_csv(OUT / "leakage_per_query.csv", index=False, encoding="utf-8")
print(json.dumps(summary, indent=2))

# Example candidates: unflagged, cited paper first under C2, large gain, readable context
c = clean.copy()
c["gain"] = c["rank_C1"] - c["rank_C2"]
c["ctx_len"] = c["context_text"].str.len()
c = c[(c["rank_C2"] == 1) & c["context_text"].str.match(r"[A-Z]") & c["ctx_len"].between(80, 260)
      & ~c["context_text"].str.contains(r"et al|\(\d{4}\)|\d{4}\)", regex=True)]
c = c.sort_values(["gain", "ctx_len"], ascending=[False, True])
idx = {e: i for i, e in enumerate(q["citation_event_id"])}
pd.set_option("display.width", 250)
for r in c.head(15).itertuples():
    print(f"\n[{idx[r.citation_event_id]}] {r.intent} C1#{r.rank_C1} C2#{r.rank_C2} C3#{r.rank_C3} | target: {r.title[:70]} ({r.creator}, {r.year})")
    print("   title:", r.title_text[:100])
    print("   ctx  :", r.context_text[:240])
