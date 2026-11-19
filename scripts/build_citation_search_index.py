"""Precompute SciBERT candidate embeddings for the Citation Search tab.

Each seed paper is encoded once from its bibliographic metadata:
title [SEP] publication name [SEP] creator [SEP] group [SEP] category.

Writes, next to the parquet files:
  seed_scibert_embeddings.npy   float32 (N, 768), L2-normalised
  seed_scibert_ids.txt          seed_paper_id per row

Usage:
  python scripts/build_citation_search_index.py --data-dir /path/to/citationhub_data
  (defaults to $CITATIONHUB_DATA_DIR)

Takes a few minutes on CPU; the SciBERT weights (~440 MB) are downloaded on first run.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# Works from the repo (scripts/ next to backend/) and from the server's flat
# backend directory, where this script sits beside citation_search.py.
_here = Path(__file__).resolve().parent
sys.path[:0] = [str(_here), str(_here.parent / "backend")]
from citation_search import (  # noqa: E402
    EMBEDDINGS_FILE, EMBEDDING_IDS_FILE, SciBertEncoder, candidate_text,
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.environ.get("CITATIONHUB_DATA_DIR", "."))
    ap.add_argument("--batch-size", type=int, default=64)
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    seed = pd.read_parquet(
        data_dir / "seed_cited_papers_normalized.parquet",
        columns=["seed_paper_id", "title", "publication_name", "creator", "group", "category"],
    ).fillna("")
    texts = [candidate_text(r.title, r.publication_name, r.creator, r.group, r.category)
             for r in seed.itertuples(index=False)]
    # Encode short texts together so padding stays small.
    order = np.argsort([len(t) for t in texts])

    enc = SciBertEncoder()
    out = np.zeros((len(texts), 768), dtype=np.float32)
    t0 = time.time()
    step = args.batch_size * 20
    for i in range(0, len(order), step):
        idx = order[i:i + step]
        out[idx] = enc.encode([texts[k] for k in idx], batch_size=args.batch_size)
        done = min(i + step, len(order))
        print(f"{done}/{len(order)}  {time.time() - t0:.0f}s", flush=True)

    np.save(data_dir / EMBEDDINGS_FILE, out)
    (data_dir / EMBEDDING_IDS_FILE).write_text("\n".join(seed["seed_paper_id"]), encoding="utf-8")
    print(f"Wrote {EMBEDDINGS_FILE} {out.shape} to {data_dir}")


if __name__ == "__main__":
    main()
