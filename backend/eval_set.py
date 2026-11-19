"""The evaluation set behind Citation search.

Citation search runs on a fixed evaluation set of 1,975 IDCite citation events, each
with a fixed set of 100 same-field candidate seed papers (one of them the paper cited
in that event). The files are produced from the IDCite Parquet tables by
``extract_candidates.py`` (random seed 42) and stored under ``<data dir>/eval_set/``:

    test_queries_1975.parquet              citing title, citation context, intent, cited paper
    test_candidate_matrix.npy              1,975 x 100 seed row numbers (row order of
                                           seed_cited_papers_normalized.parquet)
    reference_ranks.csv                    previously saved reference ranks (optional)
    extraction_stats.json                  counts printed by the generator (optional)

For a selected citation event the candidates are ranked live with the same encoder,
texts and conditions as the offline evaluation (C1 title; C2 title + 0.75 context;
C3 title + 0.75 intent-conditioned context), so every rank can be compared with the
saved reference ranks.
"""
from __future__ import annotations

import hashlib
import io
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

import citation_search as cs

EVAL_DIR = "eval_set"
QUERIES_FILE = "test_queries_1975.parquet"
MATRIX_FILE = "test_candidate_matrix.npy"
REFERENCE_RANKS_FILE = "reference_ranks.csv"
STATS_FILE = "extraction_stats.json"
REFERENCE_RUN_DATE = "2026-09-26"
CONDITIONS = ("C1", "C2", "C3")


@dataclass
class TestSet:
    queries: pd.DataFrame          # one row per citation event, in matrix row order
    matrix: np.ndarray             # (n, 100) seed row numbers
    target_pos: np.ndarray         # (n,) column of the cited paper in each row
    reference_ranks: pd.DataFrame | None
    matrix_sha256: str
    stats: dict


def load_test_set(data_dir: Path, ids: list[str], fields: np.ndarray) -> TestSet:
    """Load and check the evaluation set; raises FileNotFoundError / ValueError."""
    folder = data_dir / EVAL_DIR
    qpath, mpath = folder / QUERIES_FILE, folder / MATRIX_FILE
    if not qpath.exists() or not mpath.exists():
        raise FileNotFoundError(
            f"{QUERIES_FILE} and {MATRIX_FILE} not found in {folder}. "
            "Generate them with extract_candidates.py (see README).")
    queries = pd.read_parquet(qpath).reset_index(drop=True)
    raw = mpath.read_bytes()
    matrix = np.load(io.BytesIO(raw))
    if matrix.ndim != 2 or matrix.shape[0] != len(queries):
        raise ValueError(f"{MATRIX_FILE} has shape {matrix.shape}; expected ({len(queries)}, 100).")

    # Same checks as the offline evaluation script: every row holds 100 distinct
    # same-field papers, exactly one of which is the paper cited in that event.
    row_of = {sid: k for k, sid in enumerate(ids)}
    target_rows = queries["target_seed_id"].astype(str).map(row_of)
    if target_rows.isna().any():
        raise ValueError("Some cited papers are missing from the SciBERT index; rebuild it.")
    target_rows = target_rows.astype(int).to_numpy()
    hits = matrix == target_rows[:, None]
    if not (hits.sum(axis=1) == 1).all():
        raise ValueError("Each candidate row must contain the cited paper exactly once.")
    if not all(len(np.unique(r)) == matrix.shape[1] for r in matrix):
        raise ValueError("Candidate rows must not repeat a paper.")
    if not (fields[matrix] == fields[target_rows][:, None]).all():
        raise ValueError("Candidates must come from the cited paper's field.")
    if not all(str(e).endswith("__to__" + str(t))
               for e, t in zip(queries["citation_event_id"], queries["target_seed_id"])):
        raise ValueError("citation_event_id must end with the cited paper's id.")

    reference_ranks = None
    rpath = folder / REFERENCE_RANKS_FILE
    if rpath.exists():
        reference_ranks = pd.read_csv(rpath).set_index("citation_event_id")

    stats = {}
    spath = folder / STATS_FILE
    if spath.exists():
        stats = json.loads(spath.read_text(encoding="utf-8"))

    return TestSet(queries=queries, matrix=matrix, target_pos=hits.argmax(axis=1),
                   reference_ranks=reference_ranks,
                   matrix_sha256=hashlib.sha256(raw).hexdigest(), stats=stats)


def query_vectors(encoder: cs.SciBertEncoder, title: str, context: str, intent: str) -> dict:
    """C1/C2/C3 query vectors, identical to the offline evaluation."""
    e_t = encoder.encode([title])[0]
    e_c = encoder.encode([context])[0]
    e_ci = encoder.encode([cs.intent_conditioned_text(intent, context)])[0]
    l2 = lambda v: v / max(float(np.linalg.norm(v)), 1e-12)  # noqa: E731
    return {"C1": e_t, "C2": l2(e_t + cs.ALPHA * e_c), "C3": l2(e_t + cs.ALPHA * e_ci)}


def rank_candidates(seed_matrix: np.ndarray, candidates: np.ndarray, queries: dict) -> dict:
    """Scores and 1-based ranks of each candidate (in matrix order) per condition.

    Ties keep the matrix order (stable sort), as in the offline evaluation.
    """
    vecs = seed_matrix[candidates]
    out = {}
    for c in CONDITIONS:
        s = vecs @ queries[c]
        order = np.argsort(-s, kind="stable")
        r = np.empty(len(s), dtype=int)
        r[order] = np.arange(1, len(s) + 1)
        out[c] = {"scores": s, "ranks": r}
    return out
