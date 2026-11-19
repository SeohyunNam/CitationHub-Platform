from __future__ import annotations

import os
import io
import re
import math
import json
import unicodedata
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from functools import lru_cache
from typing import Optional

import numpy as np
import pandas as pd
import duckdb
import pyarrow.parquet as pq
import networkx as nx
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv

import citation_search as cs
import eval_set as te

load_dotenv()

HF_REPO_ID = os.environ.get("HF_REPO_ID", "")
HF_TOKEN   = os.environ.get("HF_TOKEN", "")
DATA_DIR   = Path(os.environ.get("CITATIONHUB_DATA_DIR", "/tmp/citationhub_data"))

# Checked into the repo rather than derived from the parquet files, which name every
# affiliation's city but carry no coordinates. Regenerate with scripts/build_geo_points.py.
CITY_COORDS_PATH = Path(__file__).resolve().parent / "data" / "city_coords.json"

# The map draws a few hundred bubbles at most, so /api/geo sends the busiest affiliations
# instead of all ~5,200. Mirrors FALLBACK_AFFILIATIONS in scripts/build_geo_points.py.
MAX_AFFILIATION_POINTS = 800

def _hf_url(filename: str) -> str:
    """Public HuggingFace dataset direct URL (no download needed)"""
    return f"https://huggingface.co/datasets/{HF_REPO_ID}/resolve/main/data/{filename}"

ALLOWED_INTENTS = [
    "background", "uses", "similarities", "motivation",
    "differences", "future_work", "extends",
]
INTENTS_SQL = "'" + "','".join(ALLOWED_INTENTS) + "'"

NODE_TYPE_COLORS = {
    "seed_paper":     "#111827",
    "citing_paper":   "#3b82f6",
    "citation_event": "#f59e0b",
    "journal":        "#8b5cf6",
    "author":         "#ef4444",
    "affiliation":    "#ec4899",
    "city":           "#06b6d4",
    "country":        "#f97316",
    "field":          "#6366f1",
    "intent":         "#22c55e",
}
INTENT_COLORS = {
    "background": "#94a3b8", "uses": "#22c55e",
    "similarities": "#3b82f6", "motivation": "#f59e0b",
    "differences": "#ef4444", "future_work": "#8b5cf6",
    "extends": "#06b6d4",
}

app = FastAPI(title="CitationHub API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _duck():
    """HTTPS 지원 DuckDB 연결 반환"""
    con = duckdb.connect()
    try:
        con.execute("INSTALL httpfs; LOAD httpfs;")
    except Exception:
        pass
    return con

def _init_duckdb():
    try:
        con = _duck()
        con.close()
        print("DuckDB httpfs extension loaded.")
    except Exception as e:
        print(f"DuckDB httpfs init warning: {e}")

@app.on_event("startup")
async def preload_data():
    import threading
    def _load():
        try:
            _init_duckdb()
            print("Preloading seed data from HuggingFace...")
            _load_seed_and_events()
            print("Seed data preloaded successfully.")
            # Citation search: candidate index, per-intent counts, example events, SciBERT.
            # Each is cached; warming them here keeps the first search from taking minutes.
            _load_citation_index()
            _example_pool()
            cs.get_encoder()
            print("Citation search index preloaded.")
            try:
                _load_test_set()
                print("Evaluation set loaded.")
            except (FileNotFoundError, ValueError) as e:
                print(f"Evaluation set unavailable: {e}")
        except Exception as e:
            print(f"Preload warning: {e}")
    threading.Thread(target=_load, daemon=True).start()

# ── helpers ──────────────────────────────────────────────────────────────────

def _hf_download(filename: str) -> str:
    """Download to local cache (used only for seed parquet - small file)"""
    from huggingface_hub import hf_hub_download
    return hf_hub_download(
        repo_id=HF_REPO_ID, repo_type="dataset",
        filename=f"data/{filename}", token=HF_TOKEN or None,
    )

def _path(filename: str) -> str:
    """Local path fallback (when HF_REPO_ID not set)"""
    return str(DATA_DIR / filename)

def _parquet_path(filename: str, download: bool = False) -> str:
    """
    For public datasets: use direct HTTPS URL (no disk usage).
    For private datasets or small files: download to local cache.
    """
    if not HF_REPO_ID:
        return str(DATA_DIR / filename)
    if HF_TOKEN or download:
        return _hf_download(filename)
    return _hf_url(filename)

def _safe_cols(path: str, wanted: list) -> list:
    avail = set(pq.read_schema(path).names)
    return [c for c in wanted if c in avail]

# ── data loading (cached) ────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _load_seed_and_events():
    """Returns (seed_df, events_path, filters_dict, overview_dict)"""
    # seed is small (23K rows) → download to local cache for fast repeated access
    seed_path   = _parquet_path("seed_cited_papers_normalized.parquet", download=True)
    # events is large (1.8M rows) → stream directly via HTTPS URL, no download
    events_path = _parquet_path("citation_events_normalized.parquet", download=False)

    _SEED_COLS = [
        "seed_paper_id", "doi", "title", "publication_name", "creator",
        "affilname", "affiliation_city", "affiliation_country", "group",
        "cover_date", "citedby_count", "author_id", "affiliation_id",
        "country_id", "field_id", "journal_id",
    ]
    cols = _safe_cols(seed_path, _SEED_COLS)
    raw  = pd.read_parquet(seed_path, columns=cols, engine="pyarrow")

    seed = pd.DataFrame({
        "seed_paper_id":  raw["seed_paper_id"],
        "doi":            raw.get("doi",            pd.Series(dtype=str)).fillna(""),
        "title":          raw.get("title",          pd.Series(dtype=str)).fillna(""),
        "journal":        raw.get("publication_name", pd.Series(dtype=str)).fillna(""),
        "author":         raw.get("creator",        pd.Series(dtype=str)).fillna(""),
        "affiliation":    raw.get("affilname",      pd.Series(dtype=str)).fillna(""),
        "city":           raw.get("affiliation_city",    pd.Series(dtype=str)).fillna(""),
        "country":        raw.get("affiliation_country", pd.Series(dtype=str)).fillna(""),
        "field":          raw.get("group",          pd.Series(dtype=str)).fillna(""),
        "cover_date":     raw.get("cover_date",     pd.Series(dtype=str)).fillna(""),
        "citedby_count":  pd.to_numeric(raw.get("citedby_count"), errors="coerce").fillna(0).astype(int),
    })
    for col in ["title", "doi", "journal", "field", "country", "author"]:
        seed[f"{col}_lc"] = seed[col].astype(str).str.lower()
    # cover_date is ISO-ish ("2019-03-15") or a year; first four digits are the publication year.
    seed["cover_year"] = pd.to_numeric(
        seed["cover_date"].astype(str).str.slice(0, 4), errors="coerce")
    seed = seed.sort_values(["citedby_count", "title"], ascending=[False, True]).reset_index(drop=True)

    ep = events_path.replace("\\", "/")
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    stats = con.execute(f"""
        SELECT MIN(citing_year) AS yr_min, MAX(citing_year) AS yr_max,
               COUNT(*) AS total, COUNT(DISTINCT citing_paper_id) AS n_citing
        FROM read_parquet('{ep}')
        WHERE primary_intent IN ({INTENTS_SQL})
    """).df().iloc[0]
    con.close()

    filters = {
        "fields":    sorted([x for x in seed["field"].dropna().astype(str).unique() if x]),
        "countries": sorted([x for x in seed["country"].dropna().astype(str).unique() if x]),
        "journals":  sorted([x for x in seed["journal"].dropna().astype(str).unique() if x]),
        "intents":   ALLOWED_INTENTS,
        "year_min":  int(stats["yr_min"]) if pd.notna(stats["yr_min"]) else 2000,
        "year_max":  int(stats["yr_max"]) if pd.notna(stats["yr_max"]) else 2025,
    }
    overview = {
        "seed_papers":     int(len(seed)),
        "citation_events": int(stats["total"]),
        "citing_papers":   int(stats["n_citing"]),
        "authors":         int(seed["author"].replace("", pd.NA).dropna().nunique()),
        "journals":        int(seed["journal"].replace("", pd.NA).dropna().nunique()),
        "countries":       int(seed["country"].replace("", pd.NA).dropna().nunique()),
        "fields":          int(seed["field"].replace("", pd.NA).dropna().nunique()),
        "intents":         len(ALLOWED_INTENTS),
    }
    return seed, events_path, filters, overview


def _norm_space(text: str) -> str:
    """Lower-cased text with runs of whitespace collapsed, for whole-text matching."""
    return " ".join(str(text).lower().split())


def _tokens(q: str) -> list[str]:
    return [t for t in q.strip().lower().split() if len(t) > 1]


def _contains_all(series: pd.Series, q: str) -> pd.Series:
    """True where every whitespace token of `q` appears in the (already lowercased) series."""
    tokens = _tokens(q)
    if not tokens:
        ql = q.strip().lower()
        return series.str.contains(ql, na=False, regex=False) if ql else pd.Series(True, index=series.index)
    mask = pd.Series(True, index=series.index)
    for tok in tokens:
        mask &= series.str.contains(tok, na=False, regex=False)
    return mask


def _filter_seed(seed: pd.DataFrame, *, q="", field="", country="", journal="",
                 title="", author="", year_min=None, year_max=None) -> pd.DataFrame:
    """Apply the same paper filters used by /api/search and CSV export."""
    df = seed
    if q.strip():
        ql     = q.strip().lower()
        tokens = _tokens(q)
        if tokens:
            mask = pd.Series(True, index=df.index)
            for tok in tokens:
                mask &= (
                    df["title_lc"].str.contains(tok, na=False, regex=False) |
                    df["doi_lc"].str.contains(tok, na=False, regex=False)
                )
            df = df[mask]
            exact = df["title_lc"].str.contains(ql, na=False, regex=False)
            df = pd.concat([df[exact], df[~exact]])
        else:
            df = df[
                df["title_lc"].str.contains(ql, na=False, regex=False) |
                df["doi_lc"].str.contains(ql,  na=False, regex=False)
            ]
    if title.strip():
        df = df[_contains_all(df["title_lc"], title)]
    if author.strip():
        df = df[_contains_all(df["author_lc"], author)]
    if field:
        df = df[df["field_lc"] == field.lower()]
    if country:
        df = df[df["country_lc"] == country.lower()]
    if journal.strip():
        df = df[_contains_all(df["journal_lc"], journal)]
    if year_min is not None:
        df = df[df["cover_year"].notna() & (df["cover_year"] >= year_min)]
    if year_max is not None:
        df = df[df["cover_year"].notna() & (df["cover_year"] <= year_max)]
    return df

@lru_cache(maxsize=1)
def _load_kg_nodes():
    path = _parquet_path("kg_nodes.parquet", download=True)
    cols = _safe_cols(path, ["node_id", "node_type", "label", "doi", "publication_name", "citedby_count"])
    return pd.read_parquet(path, columns=cols, engine="pyarrow")

@lru_cache(maxsize=1)
def _load_city_coords():
    """Returns {(city, country): (lat, lon)} for plotting the point layers of the map."""
    try:
        with CITY_COORDS_PATH.open(encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"City coordinates unavailable ({e}); /api/geo will omit map points.")
        return {}
    return {(c["city"], c["country"]): (c["lat"], c["lon"])
            for c in payload.get("cities", [])}

@lru_cache(maxsize=1)
def _load_authors():
    path = _parquet_path("authors.parquet", download=True)
    cols = _safe_cols(path, ["author_id", "author_name"])
    return pd.read_parquet(path, columns=cols, engine="pyarrow")

@lru_cache(maxsize=1)
def _load_author_index():
    """Returns (papers_df, meta_df) for author search / detail.

    Each seed paper carries a single (primary) author_id, so authors are
    grouped by author_id. papers_df keeps one row per (author, paper).
    """
    seed_path = _parquet_path("seed_cited_papers_normalized.parquet", download=True)
    cols = _safe_cols(seed_path, [
        "seed_paper_id", "author_id", "creator", "doi", "title",
        "publication_name", "group", "affilname",
        "affiliation_country", "affiliation_city",
        "cover_date", "citedby_count",
    ])
    df = pd.read_parquet(seed_path, columns=cols, engine="pyarrow")
    df = df[df["author_id"].notna()].copy()

    df["citedby_count"] = pd.to_numeric(df.get("citedby_count"), errors="coerce").fillna(0).astype(int)
    df["year"] = df.get("cover_date", pd.Series(dtype=str)).astype(str).str.slice(0, 4)
    for c in ["title", "doi", "publication_name", "group", "affilname",
              "affiliation_country", "affiliation_city", "creator"]:
        if c in df.columns:
            df[c] = df[c].fillna("")
        else:
            df[c] = ""

    # canonical author name from authors.parquet, fallback to creator
    try:
        authors = _load_authors()
        name_map = dict(zip(authors["author_id"], authors["author_name"]))
    except Exception:
        name_map = {}
    df["author_name"] = df["author_id"].map(name_map)
    df["author_name"] = df["author_name"].fillna(df["creator"]).fillna("")

    def _top(s):
        s = s[s.astype(str).str.len() > 0]
        m = s.mode()
        return m.iloc[0] if not m.empty else ""

    grp = df.groupby("author_id")
    meta = grp.agg(
        author_name=("author_name", "first"),
        paper_count=("seed_paper_id", "count"),
        total_citedby=("citedby_count", "sum"),
        top_field=("group", _top),
        top_affiliation=("affilname", _top),
        top_country=("affiliation_country", _top),
    ).reset_index()
    meta["name_lc"] = meta["author_name"].astype(str).str.lower()
    meta = meta.sort_values("total_citedby", ascending=False).reset_index(drop=True)
    return df, meta

# ── routes ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/overview")
def get_overview():
    _, _, filters, overview = _load_seed_and_events()
    return {"overview": overview, "filters": filters}

@app.get("/api/authors/search")
def search_authors(
    q:     str = Query(""),
    page:  int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
):
    _, meta = _load_author_index()
    df = meta
    if q.strip():
        ql = q.strip().lower()
        tokens = [t for t in ql.split() if len(t) > 1] or [ql]
        mask = pd.Series(True, index=df.index)
        for tok in tokens:
            mask &= df["name_lc"].str.contains(tok, na=False, regex=False)
        df = df[mask]
        # exact prefix / full match boosted to top
        exact = df["name_lc"].str.startswith(ql)
        df = pd.concat([df[exact], df[~exact]])

    total   = len(df)
    start   = (page - 1) * limit
    page_df = df.iloc[start : start + limit]

    results = [{
        "author_id":       r["author_id"],
        "name":            r["author_name"],
        "paper_count":     int(r["paper_count"]),
        "total_citedby":   int(r["total_citedby"]),
        "top_field":       r["top_field"],
        "top_affiliation": r["top_affiliation"],
        "top_country":     r["top_country"],
    } for _, r in page_df.iterrows()]

    return {
        "total":       total,
        "page":        page,
        "limit":       limit,
        "total_pages": math.ceil(total / limit) if total else 1,
        "results":     results,
    }

@app.get("/api/authors/{author_id}/analytics")
def author_analytics(author_id: str):
    df, _ = _load_author_index()
    pids = df[df["author_id"] == author_id]["seed_paper_id"].astype(str).tolist()
    if not pids:
        raise HTTPException(status_code=404, detail="Author not found")

    _, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")
    id_list = ",".join("'" + p.replace("'", "''") + "'" for p in pids)
    con = _duck()

    intent = con.execute(f"""
        SELECT primary_intent AS intent, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id IN ({id_list})
          AND primary_intent IN ({INTENTS_SQL})
        GROUP BY primary_intent
        ORDER BY count DESC
    """).df().to_dict("records")

    over_time = con.execute(f"""
        SELECT TRY_CAST(citing_year AS INTEGER) AS year, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id IN ({id_list})
          AND primary_intent IN ({INTENTS_SQL})
          AND TRY_CAST(citing_year AS INTEGER) >= 2000
        GROUP BY year ORDER BY year
    """).df().to_dict("records")

    venues = con.execute(f"""
        SELECT citing_venue AS venue, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id IN ({id_list})
          AND citing_venue IS NOT NULL AND citing_venue != ''
        GROUP BY citing_venue ORDER BY count DESC LIMIT 15
    """).df().to_dict("records")

    total = con.execute(f"""
        SELECT COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id IN ({id_list})
          AND primary_intent IN ({INTENTS_SQL})
    """).df().iloc[0]["count"]

    return {
        "intent_distribution": intent,
        "citations_over_time": over_time,
        "top_venues":          venues,
        "total_events":        int(total),
        "intent_colors":       INTENT_COLORS,
    }

@app.get("/api/authors/{author_id}")
def author_detail(author_id: str):
    df, meta = _load_author_index()
    m = meta[meta["author_id"] == author_id]
    if m.empty:
        raise HTTPException(status_code=404, detail="Author not found")
    row = m.iloc[0]

    papers = df[df["author_id"] == author_id].sort_values("citedby_count", ascending=False)
    paper_list = (papers[["seed_paper_id", "title", "doi", "publication_name",
                          "group", "affiliation_country", "year", "citedby_count"]]
                  .rename(columns={"publication_name": "journal",
                                   "group": "field",
                                   "affiliation_country": "country"})
                  .to_dict("records"))

    fields    = sorted({x for x in papers["group"].tolist() if x})
    affs      = sorted({x for x in papers["affilname"].tolist() if x})
    countries = sorted({x for x in papers["affiliation_country"].tolist() if x})

    return {
        "author": {
            "author_id":     author_id,
            "name":          row["author_name"],
            "paper_count":   int(row["paper_count"]),
            "total_citedby": int(row["total_citedby"]),
            "fields":        fields,
            "affiliations":  affs,
            "countries":     countries,
        },
        "papers": paper_list,
    }

@app.get("/api/search")
def search_papers(
    q:        str = Query(""),
    field:    str = Query(""),
    country:  str = Query(""),
    journal:  str = Query(""),
    title:    str = Query(""),
    author:   str = Query(""),
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
    page:     int = Query(1, ge=1),
    limit:    int = Query(20, ge=1, le=100),
):
    seed, _, _, _ = _load_seed_and_events()
    df = _filter_seed(
        seed, q=q, field=field, country=country, journal=journal,
        title=title, author=author, year_min=year_min, year_max=year_max,
    )

    total = len(df)
    start = (page - 1) * limit
    page_df = df.iloc[start : start + limit]

    results = page_df[["seed_paper_id", "title", "doi", "journal", "author",
                        "affiliation", "city", "country", "field",
                        "cover_date", "citedby_count"]].to_dict(orient="records")
    return {
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": math.ceil(total / limit),
        "results": results,
    }

def _records(df: pd.DataFrame) -> list[dict]:
    """Rows as dicts with missing values (NaN) as None, which JSON can encode."""
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")


def _seed_row_or_404(seed_paper_id: str) -> pd.Series:
    seed, _, _, _ = _load_seed_and_events()
    row = seed[seed["seed_paper_id"] == seed_paper_id]
    if row.empty:
        raise HTTPException(status_code=404, detail="Paper not found")
    return row.iloc[0]


def _paper_events(seed_paper_id: str, sel: list[str],
                  year_min: Optional[int] = None, year_max: Optional[int] = None) -> pd.DataFrame:
    """Citation events of one seed paper.

    Every event carrying one of the seven intents counts, including events with two
    labels ("background similarities"); with an intent filter, only events carrying a
    selected label.
    """
    _, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")
    sid = seed_paper_id.replace("'", "''")
    intent_sql = _intent_filter_sql(sel or ALLOWED_INTENTS)
    year_sql = ""
    if year_min is not None:
        year_sql += f" AND TRY_CAST(citing_year AS INTEGER) >= {int(year_min)}"
    if year_max is not None:
        year_sql += f" AND TRY_CAST(citing_year AS INTEGER) <= {int(year_max)}"
    events = _duck().execute(f"""
        SELECT citation_event_id,
               cited_seed_paper_id AS seed_paper_id,
               citing_paper_id, citing_title, citing_doi,
               TRY_CAST(citing_year AS INTEGER) AS citing_year,
               citing_venue, primary_intent, contexts,
               TRY_CAST(context_count AS INTEGER) AS context_count,
               TRY_CAST(intent_count  AS INTEGER) AS intent_count,
               is_influential
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id = '{sid}'
          AND {intent_sql}
          {year_sql}
        ORDER BY context_count DESC NULLS LAST
    """).df()
    if sel:
        # a multi-label event is shown under the selected intent
        events["primary_intent"] = events["primary_intent"].map(
            lambda v: next((i for i in str(v).split() if i in sel), v))
    return events


_CITING_COLUMNS = ["citation_event_id", "citing_paper_id", "citing_title",
                   "citing_doi", "citing_year", "primary_intent", "context_count"]


def _citing_papers(events: pd.DataFrame) -> pd.DataFrame:
    """One row per citing paper, most citation contexts first."""
    return (events.sort_values(["context_count", "intent_count", "citing_year"],
                               ascending=[False, False, False], na_position="last")
                  .drop_duplicates(subset=["citing_paper_id"]))


def _cocited(seed_paper_id: str, offset: int, limit: int) -> tuple[list[dict], int]:
    """Seed papers cited by the same citing papers, most co-citations first.

    Returns one page of rows and the total number of co-cited seed papers.
    """
    seed, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")
    sid = seed_paper_id.replace("'", "''")
    raw = _duck().execute(f"""
        WITH citing_ids AS (
            SELECT DISTINCT citing_paper_id
            FROM read_parquet('{ep}')
            WHERE cited_seed_paper_id = '{sid}'
        ),
        counts AS (
            SELECT cited_seed_paper_id AS seed_paper_id, COUNT(*) AS co_citation_count
            FROM read_parquet('{ep}')
            WHERE citing_paper_id IN (SELECT citing_paper_id FROM citing_ids)
              AND cited_seed_paper_id != '{sid}'
            GROUP BY cited_seed_paper_id
        )
        SELECT *, COUNT(*) OVER () AS total
        FROM counts
        ORDER BY co_citation_count DESC, seed_paper_id
        LIMIT {int(limit)} OFFSET {int(offset)}
    """).df()
    total = int(raw["total"].iloc[0]) if len(raw) else 0
    rows = _records(raw.drop(columns=["total"]).merge(
        seed[["seed_paper_id", "title", "field", "journal", "citedby_count"]],
        on="seed_paper_id", how="left"
    ))
    return rows, total


def _page(total: int, page: int, limit: int, results: list) -> dict:
    return {"total": total, "page": page, "limit": limit,
            "total_pages": max(1, math.ceil(total / limit)), "results": results}


# Declared before /api/papers/{seed_paper_id:path}, whose :path would otherwise
# match ".../citing" as part of the paper id.
@app.get("/api/citing/{seed_paper_id:path}")
def citing_page(seed_paper_id: str,
                page: int = Query(1, ge=1),
                limit: int = Query(20, ge=1, le=100),
                intents: str = Query("", description="Comma-separated intents; empty = all")):
    """One page of a seed paper's citing papers (most citation contexts first)."""
    _seed_row_or_404(seed_paper_id)
    citing = _citing_papers(_paper_events(seed_paper_id, _parse_intents(intents)))
    rows = citing.iloc[(page - 1) * limit: page * limit][_CITING_COLUMNS]
    return _page(len(citing), page, limit, _records(rows))


@app.get("/api/cocited/{seed_paper_id:path}")
def cocited_page(seed_paper_id: str,
                 page: int = Query(1, ge=1),
                 limit: int = Query(20, ge=1, le=100)):
    """One page of the seed papers co-cited with a seed paper (most co-citations first)."""
    _seed_row_or_404(seed_paper_id)
    rows, total = _cocited(seed_paper_id, (page - 1) * limit, limit)
    return _page(total, page, limit, rows)


@app.get("/api/papers/{seed_paper_id:path}")
def get_paper(
    seed_paper_id: str,
    year_min: Optional[int] = Query(None, description="Citing year from (default: no limit)"),
    year_max: Optional[int] = Query(None, description="Citing year to (default: no limit)"),
    intents:  str = Query("", description="Comma-separated intents; empty = all"),
    limit:    int = Query(30, ge=1, le=2000, description="Maximum number of citing papers returned"),
    cocited_limit: int = Query(15, ge=1, le=100, description="Maximum number of co-cited papers returned"),
):
    paper = _records(_seed_row_or_404(seed_paper_id).to_frame().T)[0]
    sel = _parse_intents(intents)
    events = _paper_events(seed_paper_id, sel, year_min, year_max)

    # Count every label of an event ("background similarities" counts once under each),
    # as in Citation search; with a filter, only the selected labels are counted.
    counted = sel or ALLOWED_INTENTS
    intent_counts = {i: 0 for i in ALLOWED_INTENTS}
    for labels in events["primary_intent"].astype(str).str.split():
        for lab in labels:
            if lab in counted:
                intent_counts[lab] += 1
    intent_summary = [{"intent": k, "count": v} for k, v in intent_counts.items()]

    unique_citing = _citing_papers(events)
    citing = _records(unique_citing.head(limit)[_CITING_COLUMNS])
    cocited, cocited_total = _cocited(seed_paper_id, 0, cocited_limit)

    # context rows (sample)
    ctx_rows = []
    for _, r in events.sort_values(["context_count", "citing_year"],
                                    ascending=[False, False]).head(50).iterrows():
        ctx = r["contexts"]
        if isinstance(ctx, list) and ctx:
            for c in ctx[:2]:
                ctx_rows.append({
                    "primary_intent": r["primary_intent"],
                    "citing_title":   r["citing_title"],
                    "citing_doi":     r["citing_doi"],
                    "citing_year":    None if pd.isna(r["citing_year"]) else int(r["citing_year"]),
                    "context":        c,
                })
        if len(ctx_rows) >= 20:
            break

    return {
        "paper":          paper,
        "total_events":   len(events),
        "unique_citing":  int(len(unique_citing)),
        "intent_summary": intent_summary,
        "citing_papers":  citing,
        "cocited_papers": cocited,
        "cocited_total":  cocited_total,
        "context_samples": ctx_rows,
    }

@app.get("/api/kg/{seed_paper_id:path}")
def get_kg(seed_paper_id: str):
    seed, events_path, _, _ = _load_seed_and_events()
    row = seed[seed["seed_paper_id"] == seed_paper_id]
    if row.empty:
        raise HTTPException(status_code=404, detail="Paper not found")
    p = row.iloc[0]

    def node(nid, ntype, label, size=16):
        return {"id": nid, "type": ntype, "label": str(label)[:50],
                "color": NODE_TYPE_COLORS.get(ntype, "#94a3b8"), "size": size}

    nodes, edges = [], []

    # ── Seed paper (centre) ────────────────────────────────────────────────
    sid = seed_paper_id
    nodes.append(node(sid, "seed_paper", str(p["title"])[:45] or sid, size=30))

    # ── Metadata nodes ─────────────────────────────────────────────────────
    def add_meta(raw_val, ntype, prefix, edge_label, parent_id):
        val = str(raw_val).strip()
        if not val or val in ("", "nan"):
            return None
        nid = f"{prefix}:{val[:60]}"
        nodes.append(node(nid, ntype, val[:40]))
        edges.append({"source": parent_id, "target": nid, "label": edge_label})
        return nid

    journal_id = add_meta(p.get("journal",""), "journal", "journal",
                          "publishedInJournal", sid)
    field_id   = add_meta(p.get("field",""),   "field",   "field",
                          "belongsToField",    sid)
    aff_id     = add_meta(p.get("affiliation",""), "affiliation", "aff",
                          "hasAffiliation",    sid)
    city_id    = add_meta(p.get("city",""),    "city",    "city",
                          "locatedInCity",     sid)
    ctry_id    = add_meta(p.get("country",""), "country", "country",
                          "locatedInCountry",  sid)

    # Link affiliation → city → country
    if aff_id and city_id:
        edges.append({"source": aff_id, "target": city_id, "label": "inCity"})
    if city_id and ctry_id:
        edges.append({"source": city_id, "target": ctry_id, "label": "inCountry"})

    # Authors (comma-separated)
    authors = [a.strip() for a in str(p.get("author","")).split(",") if a.strip()]
    for auth in authors[:5]:
        aid = f"author:{auth[:40]}"
        nodes.append(node(aid, "author", auth[:35]))
        edges.append({"source": sid, "target": aid, "label": "hasAuthor"})

    # ── Citation events from events parquet ────────────────────────────────
    ep      = events_path.replace("\\", "/")
    safe_id = seed_paper_id.replace("'", "''")
    try:
        ev_df = _duck().execute(f"""
            SELECT primary_intent, citing_paper_id, citing_title,
                   TRY_CAST(citing_year AS INTEGER) AS citing_year,
                   TRY_CAST(context_count AS INTEGER) AS context_count,
                   TRY_CAST(is_influential AS BOOLEAN) AS is_influential
            FROM read_parquet('{ep}')
            WHERE cited_seed_paper_id = '{safe_id}'
              AND primary_intent IN ({INTENTS_SQL})
            LIMIT 300
        """).df()
    except Exception:
        ev_df = pd.DataFrame()

    # Add one intent node per distinct intent
    intent_added = set()
    # Add up to 30 citation_event nodes (top by context_count)
    if not ev_df.empty:
        ev_df = ev_df.sort_values("context_count", ascending=False, na_position="last")
        for _, ev in ev_df.head(30).iterrows():
            intent = str(ev.get("primary_intent", "background"))
            cid    = str(ev.get("citing_paper_id", ""))
            ctitle = str(ev.get("citing_title", cid))[:40]

            # Intent node
            if intent not in intent_added:
                int_nid = f"intent:{intent}"
                nodes.append(node(int_nid, "intent", intent, size=14))
                intent_added.add(intent)

            # Citation event node
            ev_nid = f"event:{cid[:50]}"
            if not any(n["id"] == ev_nid for n in nodes):
                nodes.append(node(ev_nid, "citation_event",
                                  ctitle[:35] or cid[:35], size=10))
                edges.append({"source": ev_nid, "target": sid, "label": "cites"})
                edges.append({"source": ev_nid, "target": f"intent:{intent}",
                              "label": "hasIntent"})

    return {"nodes": nodes, "edges": edges}

@app.get("/api/geo")
def get_geo():
    seed, _, _, _ = _load_seed_and_events()

    country_counts = (seed[seed["country"] != ""]
                      .groupby("country", dropna=True)
                      .size().reset_index(name="count")
                      .rename(columns={"country": "name"})
                      .sort_values("count", ascending=False)
                      .head(30).to_dict(orient="records"))

    city_counts = (seed[seed["city"] != ""]
                   .groupby("city", dropna=True)
                   .size().reset_index(name="count")
                   .rename(columns={"city": "name"})
                   .sort_values("count", ascending=False)
                   .head(30).to_dict(orient="records"))

    affiliation_counts = (seed[seed["affiliation"] != ""]
                          .groupby("affiliation", dropna=True)
                          .size().reset_index(name="count")
                          .rename(columns={"affiliation": "name"})
                          .sort_values("count", ascending=False)
                          .head(30).to_dict(orient="records"))

    # Map points. Everything is grouped with its country as well as its city so that
    # same-named cities (Cambridge US / Cambridge UK) stay distinct and get the right
    # coordinates. Affiliations sit on their city's coordinates — the dataset locates
    # them no more precisely than that — so co-located ones share a point and it is the
    # map that pulls them apart.
    coords = _load_city_coords()
    located = seed[(seed["city"] != "") & (seed["country"] != "")]

    def counts_by(frame, cols):
        return (frame.groupby(cols)
                     .size().reset_index(name="count")
                     .sort_values("count", ascending=False))

    city_points = []
    affiliation_points = []
    if coords:
        by_city = counts_by(located, ["city", "country"])
        for city, country, count in by_city.itertuples(index=False):
            latlon = coords.get((city, country))
            if latlon is None:
                continue
            city_points.append({
                "name": city, "country": country,
                "lat": latlon[0], "lon": latlon[1], "count": int(count),
            })

        named = located[located["affiliation"] != ""]
        by_affiliation = counts_by(named, ["affiliation", "city", "country"])
        for name, city, country, count in by_affiliation.itertuples(index=False):
            latlon = coords.get((city, country))
            if latlon is None:
                continue
            affiliation_points.append({
                "name": name, "city": city, "country": country,
                "lat": latlon[0], "lon": latlon[1], "count": int(count),
            })
            if len(affiliation_points) == MAX_AFFILIATION_POINTS:
                break

    return {
        "country_counts":     country_counts,
        "city_counts":        city_counts,
        "affiliation_counts": affiliation_counts,
        "city_points":        city_points,
        "affiliation_points": affiliation_points,
    }

@app.get("/api/analytics")
def get_analytics():
    _, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")

    intent_trend = _duck().execute(f"""
        SELECT TRY_CAST(citing_year AS INTEGER) AS year,
               primary_intent, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE primary_intent IN ({INTENTS_SQL})
          AND TRY_CAST(citing_year AS INTEGER) >= 2000
        GROUP BY year, primary_intent
        ORDER BY year
    """).df().to_dict(orient="records")

    venues = _duck().execute(f"""
        SELECT citing_venue AS venue, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE primary_intent IN ({INTENTS_SQL})
          AND citing_venue IS NOT NULL AND citing_venue != ''
        GROUP BY citing_venue
        ORDER BY count DESC
        LIMIT 20
    """).df().to_dict(orient="records")

    influential = _duck().execute(f"""
        SELECT is_influential, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE primary_intent IN ({INTENTS_SQL})
        GROUP BY is_influential
    """).df().to_dict(orient="records")

    global_intent = _duck().execute(f"""
        SELECT primary_intent AS intent, COUNT(*) AS count
        FROM read_parquet('{ep}')
        WHERE primary_intent IN ({INTENTS_SQL})
        GROUP BY primary_intent
    """).df().to_dict(orient="records")

    return {
        "intent_trend":    intent_trend,
        "top_venues":      venues,
        "influential":     influential,
        "global_intent":   global_intent,
        "intent_colors":   INTENT_COLORS,
    }

@app.get("/api/export/search")
def export_search(
    q:        str = Query(""),
    field:    str = Query(""),
    country:  str = Query(""),
    journal:  str = Query(""),
    title:    str = Query(""),
    author:   str = Query(""),
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
):
    seed, _, _, _ = _load_seed_and_events()
    df = _filter_seed(
        seed, q=q, field=field, country=country, journal=journal,
        title=title, author=author, year_min=year_min, year_max=year_max,
    )

    out = df[["seed_paper_id", "title", "doi", "journal", "author",
              "affiliation", "city", "country", "field",
              "cover_date", "citedby_count"]]
    buf = io.StringIO()
    out.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=citationhub_search.csv"},
    )

@app.get("/api/export/paper/{seed_paper_id:path}")
def export_paper_events(seed_paper_id: str,
                        intents: str = Query("", description="Comma-separated intents; empty = all")):
    seed, events_path, filters, _ = _load_seed_and_events()
    row = seed[seed["seed_paper_id"] == seed_paper_id]
    if row.empty:
        raise HTTPException(status_code=404, detail="Paper not found")

    ep  = events_path.replace("\\", "/")
    sid = seed_paper_id.replace("'", "''")
    sel = _parse_intents(intents)
    intent_sql = _intent_filter_sql(sel or ALLOWED_INTENTS)
    events = _duck().execute(f"""
        SELECT citation_event_id, citing_paper_id, citing_title, citing_doi, citing_year,
               citing_venue, primary_intent, context_count, is_influential,
               array_to_string(contexts, ' || ') AS contexts
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id = '{sid}'
          AND {intent_sql}
        ORDER BY context_count DESC NULLS LAST
    """).df()

    buf = io.StringIO()
    buf.write("﻿")  # BOM so Excel opens UTF-8 correctly
    events.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=citations_{seed_paper_id[:20]}.csv"},
    )

# ---------------------------------------------------------------------------
# Citation search: citation-context-aware ranking (C1/C2/C3) of seed papers,
# shown with the citation contexts in which they were cited with the selected intents.
#
# The site ranks with C2 (title + citation context). The intent is used to select
# candidates (papers cited with that intent) and to choose the citation contexts shown
# as evidence; C3 (intent-conditioned query) stays available through the API.
# ---------------------------------------------------------------------------
CONDITIONS = ["C1", "C2", "C3"]
DEFAULT_CONDITION = "C2"
CONDITION_LABELS = {
    "C1": "Title",
    "C2": "Title + Context",
    "C3": "Title + Context + Intent",
}
EXAMPLES_PER_INTENT = 300  # capped stratified sampling, as in the evaluation set


def _intent_filter_sql(intents: list[str]) -> str:
    """primary_intent may hold several space-separated labels ("motivation background")."""
    arr = "[" + ",".join(f"'{i}'" for i in intents) + "]"
    return f"list_has_any(string_split(primary_intent, ' '), {arr})"


def _parse_intents(raw: str) -> list[str]:
    out = []
    for tok in (raw or "").replace(" ", ",").split(","):
        t = tok.strip().lower()
        if t in ALLOWED_INTENTS and t not in out:
            out.append(t)
    return out


@lru_cache(maxsize=1)
def _load_citation_index():
    """(ids, matrix, meta, intent_counts) aligned row by row."""
    seed, _, _, _ = _load_seed_and_events()
    ids, matrix = cs.load_candidate_index(DATA_DIR)
    meta = (seed.set_index("seed_paper_id")
                .reindex(ids)[["title", "doi", "journal", "author", "field",
                               "cover_year", "citedby_count"]]
                .reset_index())
    counts = _seed_intent_counts().reindex(ids).fillna(0).astype(int)
    return ids, matrix, meta, counts


@lru_cache(maxsize=1)
def _seed_intent_counts() -> pd.DataFrame:
    """Citation events per (seed paper, intent): rows = seed ids, columns = intents."""
    _, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")
    df = _duck().execute(f"""
        SELECT cited_seed_paper_id AS sid, intent, COUNT(*) AS n
        FROM (SELECT cited_seed_paper_id,
                     UNNEST(string_split(primary_intent, ' ')) AS intent
              FROM read_parquet('{ep}'))
        WHERE intent IN ({INTENTS_SQL})
        GROUP BY ALL
    """).df()
    return df.pivot(index="sid", columns="intent", values="n") \
             .reindex(columns=ALLOWED_INTENTS).fillna(0)


@lru_cache(maxsize=1)
def _example_pool() -> pd.DataFrame:
    """Real IDCite citation events (up to 300 per intent) used as example queries."""
    _, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")
    df = _duck().execute(f"""
        SELECT citation_event_id, citing_title, cited_seed_paper_id,
               primary_intent AS intent, contexts[1] AS context
        FROM read_parquet('{ep}')
        WHERE primary_intent IN ({INTENTS_SQL})
          AND citing_title IS NOT NULL AND length(citing_title) > 10
          AND len(contexts) > 0 AND length(contexts[1]) > 40
        QUALIFY row_number() OVER (PARTITION BY primary_intent
                                   ORDER BY hash(citation_event_id)) <= {EXAMPLES_PER_INTENT}
    """).df()
    ids, _, meta, _ = _load_citation_index()
    field_of = dict(zip(ids, meta["field"]))
    df["field"] = df["cited_seed_paper_id"].map(field_of)
    return df[df["field"].notna()].reset_index(drop=True)


def _citation_index_or_503():
    try:
        return _load_citation_index()
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=503, detail=str(e))


def _paper_out(meta: pd.DataFrame, row: int) -> dict:
    r = meta.iloc[row]
    return {
        "seed_paper_id": r["seed_paper_id"],
        "title":         r["title"],
        "doi":           r["doi"],
        "journal":       r["journal"],
        "author":        r["author"],
        "field":         r["field"],
        "year":          None if pd.isna(r["cover_year"]) else int(r["cover_year"]),
        "citedby_count": int(r["citedby_count"]) if pd.notna(r["citedby_count"]) else 0,
    }


@lru_cache(maxsize=1)
def _candidate_masks() -> dict:
    """Candidate counts by field and intent set, for the page's live count.

    Each paper gets a 7-bit mask of the intents it has been cited with (bit k =
    ALLOWED_INTENTS[k]); the result is {field: {mask: number of papers}}. The page
    sums the masks that share a bit with the selected intents, which reproduces the
    candidate filter of /api/citation-search without running a search.
    """
    _, _, meta, counts = _load_citation_index()
    bits = (counts[ALLOWED_INTENTS].to_numpy() > 0).astype(np.int64)
    masks = bits @ (1 << np.arange(len(ALLOWED_INTENTS), dtype=np.int64))
    frame = pd.DataFrame({"field": meta["field"].fillna("").to_numpy(), "mask": masks})
    out: dict = {}
    for (f, m), n in frame.groupby(["field", "mask"]).size().items():
        out.setdefault(f, {})[str(int(m))] = int(n)
    return out


@app.get("/api/citation-search/meta")
def citation_search_meta():
    seed, _, filters, _ = _load_seed_and_events()
    try:
        ids, _, meta, _ = _load_citation_index()
        index_ready, index_size, index_error = True, len(ids), None
        candidate_masks = _candidate_masks()
    except (FileNotFoundError, ValueError) as e:
        index_ready, index_size, index_error = False, 0, str(e)
        candidate_masks = {}
    field_counts = seed["field"].value_counts().to_dict()
    return {
        "index_ready":  index_ready,
        "index_size":   index_size,
        "index_error":  index_error,
        "model":        cs.SCIBERT_MODEL,
        "alpha":        cs.ALPHA,
        "fields":       [{"name": f, "count": int(field_counts.get(f, 0))} for f in filters["fields"]],
        "intents":      [{"id": i, "label": cs.intent_label(i).title(),
                          "description": cs.INTENT_DESCRIPTIONS[i],
                          "color": INTENT_COLORS[i]} for i in ALLOWED_INTENTS],
        "conditions":   [{"id": c, "label": CONDITION_LABELS[c]} for c in CONDITIONS],
        # {field: {intent bitmask: papers}}; bit order = order of "intents" above
        "candidate_masks": candidate_masks,
    }


@app.get("/api/citation-search/example")
def citation_search_example(intent: str = Query(""), field: str = Query(""),
                            n: int = Query(0, ge=0)):
    """One real citation event to use as a query; `n` picks a deterministic row."""
    _citation_index_or_503()
    pool = _example_pool()
    if intent in ALLOWED_INTENTS:
        pool = pool[pool["intent"] == intent]
    if field:
        pool = pool[pool["field"] == field]
    if pool.empty:
        raise HTTPException(status_code=404, detail="No example citation event for this filter.")
    r = pool.iloc[n % len(pool)]
    return {
        "citation_event_id":   r["citation_event_id"],
        "title":               r["citing_title"],
        "context":             r["context"],
        "intent":              r["intent"],
        "field":               r["field"],
        "cited_seed_paper_id": r["cited_seed_paper_id"],
        "pool_size":           int(len(pool)),
    }


@app.get("/api/citation-search")
def citation_search(
    title:       str = Query("", description="Bibliographic query: the citing paper's title"),
    context:     str = Query("", description="Citation context: the sentence that needs a citation"),
    intents:     str = Query("", description="Comma-separated citation intents"),
    field:       str = Query("", description="Restrict candidates to one scientific field"),
    condition:   str = Query(DEFAULT_CONDITION),
    require_intent: bool = Query(True, description="Only papers cited with a selected intent"),
    target:      str = Query("", description="Seed paper actually cited (example queries)"),
    limit:       int = Query(10, ge=1, le=30),
):
    sel = _parse_intents(intents)
    if not title.strip() and not context.strip():
        raise HTTPException(status_code=400, detail="Enter a paper title, a citation context, or both.")
    condition = condition.upper() if condition.upper() in CONDITIONS else DEFAULT_CONDITION
    if condition == "C1" and not title.strip():
        condition = "C2"

    ids, matrix, meta, counts = _citation_index_or_503()

    mask = np.ones(len(ids), dtype=bool)
    if field:
        mask &= (meta["field"] == field).to_numpy()
    if require_intent and sel:
        mask &= (counts[sel].to_numpy().sum(axis=1) > 0)
    cand = np.flatnonzero(mask)
    if cand.size == 0:
        raise HTTPException(status_code=404, detail="No candidate papers match these filters.")

    try:
        encoder = cs.get_encoder()
    except Exception as e:  # noqa: BLE001 — model download / torch import failures
        raise HTTPException(status_code=503, detail=f"SciBERT encoder unavailable: {e}")
    queries = cs.build_queries(encoder, title, context, sel)
    sub = matrix[cand]
    scores = {c: cs.score(queries[c], sub) for c in CONDITIONS}
    ranks = {c: (cs.ranks_from_scores(s) if s is not None else None) for c, s in scores.items()}

    order = np.argsort(-scores[condition], kind="stable")[:limit]
    top_rows = cand[order]
    top_ids = [ids[i] for i in top_rows]

    def rank_info(pos):
        return {
            "scores": {c: (None if scores[c] is None else round(float(scores[c][pos]), 4)) for c in CONDITIONS},
            "ranks":  {c: (None if ranks[c] is None else int(ranks[c][pos])) for c in CONDITIONS},
        }

    results = []
    for k, (pos, row) in enumerate(zip(order, top_rows), start=1):
        item = _paper_out(meta, row)
        item.update(rank_info(pos))
        item["rank"] = k
        item["score"] = item["scores"][condition]
        item["intent_counts"] = {i: int(counts.iloc[row][i]) for i in ALLOWED_INTENTS}
        results.append(item)

    target_info = None
    if target:
        where = np.flatnonzero(np.asarray(ids)[cand] == target)
        if where.size:
            target_info = _paper_out(meta, cand[where[0]])
            target_info.update(rank_info(where[0]))
        else:
            target_info = {"seed_paper_id": target, "excluded": True}

    evidence = _citation_contexts(top_ids, sel)
    for item in results:
        item["evidence"] = {"contexts": evidence.get(item["seed_paper_id"], [])}

    return {
        "query": {"title": title, "context": context, "intents": sel, "field": field,
                  "condition": condition,
                  "require_intent": require_intent},
        "condition_label": CONDITION_LABELS[condition],
        "candidates":     int(cand.size),
        "alpha":          cs.ALPHA,
        "results":        results,
        "target":         target_info,
    }


def _citation_contexts(top_ids: list[str], intents: list[str], per_paper: int = 4,
                       exclude_citing: str = "") -> dict:
    """For each ranked paper, the citing papers' contexts carrying a selected intent.

    ``exclude_citing`` leaves out one citing paper, e.g. the paper a test query was
    taken from, so its own sentence is not shown as evidence.
    """
    if not top_ids:
        return {}
    _, events_path, _, _ = _load_seed_and_events()
    ep = events_path.replace("\\", "/")
    id_list = ",".join("'" + i.replace("'", "''") + "'" for i in top_ids)
    intent_sql = _intent_filter_sql(intents or ALLOWED_INTENTS)
    exclude_sql = (f"AND citing_paper_id <> '{exclude_citing.replace(chr(39), chr(39) * 2)}'"
                   if exclude_citing else "")
    ev = _duck().execute(f"""
        SELECT cited_seed_paper_id AS sid, citing_paper_id, citing_title,
               TRY_CAST(citing_year AS INTEGER) AS citing_year,
               primary_intent, contexts
        FROM read_parquet('{ep}')
        WHERE cited_seed_paper_id IN ({id_list})
          AND {intent_sql}
          AND len(contexts) > 0
          {exclude_sql}
        QUALIFY row_number() OVER (PARTITION BY cited_seed_paper_id
                                   ORDER BY TRY_CAST(context_count AS INTEGER) DESC NULLS LAST,
                                            citing_year DESC NULLS LAST) <= {per_paper}
    """).df()

    out: dict[str, list] = {}
    for r in ev.itertuples(index=False):
        ev_intents = [i for i in str(r.primary_intent).split() if i in ALLOWED_INTENTS]
        shown = next((i for i in ev_intents if i in intents), ev_intents[0] if ev_intents else "background")
        out.setdefault(r.sid, []).append({
            "citing_paper_id": r.citing_paper_id,
            "citing_title":    r.citing_title,
            "citing_year":     None if pd.isna(r.citing_year) else int(r.citing_year),
            "intent":          shown,
            "contexts":        [str(t) for t in list(r.contexts)[:2]],
        })
    return out


# ── Citation search on the evaluation set ───────────────────────────────────
TEST_RESULT_LIMIT = 10


@lru_cache(maxsize=1)
def _load_test_set():
    """(TestSet, listing DataFrame). Raises FileNotFoundError / ValueError if unusable."""
    ids, _, meta, _ = _load_citation_index()
    seed_path = _parquet_path("seed_cited_papers_normalized.parquet", download=True)
    field_ids = (pd.read_parquet(seed_path, columns=["seed_paper_id", "field_id"])
                   .set_index("seed_paper_id")["field_id"].reindex(ids).to_numpy())
    ts = te.load_test_set(DATA_DIR, ids, field_ids)
    row_of = {sid: k for k, sid in enumerate(ids)}
    q = ts.queries
    listing = pd.DataFrame({
        "idx":     np.arange(len(q)),
        "intent":  q["intent"].astype(str),
        "field":   q["target_seed_id"].astype(str).map(lambda s: meta["field"].iloc[row_of[s]]),
        "title":   q["title_text"].fillna("").astype(str),
        "context": q["context_text"].fillna("").astype(str),
        # First author and year of the cited paper (used to pick example events).
        "cited_author": q["target_seed_id"].astype(str).map(lambda s: meta["author"].iloc[row_of[s]]).fillna("").astype(str),
        "cited_year":   q["target_seed_id"].astype(str).map(lambda s: meta["cover_year"].iloc[row_of[s]]),
    })
    listing["text_lc"] = (listing["title"] + " " + listing["context"]).str.lower()
    listing["title_lc"] = listing["title"].map(_norm_space)
    listing["context_lc"] = listing["context"].map(_norm_space)
    return ts, listing


def _test_set_or_503():
    try:
        return _load_test_set()
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=503, detail=str(e))


@lru_cache(maxsize=256)
def _rank_test_query(idx: int) -> dict:
    """Live C1/C2/C3 scores and ranks of one test query's 100 candidates."""
    ts, _ = _test_set_or_503()
    _, matrix, _, _ = _load_citation_index()
    q = ts.queries.iloc[idx]
    try:
        encoder = cs.get_encoder()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"SciBERT encoder unavailable: {e}")
    qv = te.query_vectors(encoder, str(q["title_text"]), str(q["context_text"]), str(q["intent"]))
    return te.rank_candidates(matrix, ts.matrix[idx], qv)


def _test_query_out(ts, listing, idx: int) -> dict:
    q = ts.queries.iloc[idx]
    return {
        "idx":               int(idx),
        "citation_event_id": q["citation_event_id"],
        "citing_paper_id":   q["citing_paper_id"],
        "title":             listing["title"].iloc[idx],
        "context":           listing["context"].iloc[idx],
        "intent":            q["intent"],
        "field":             listing["field"].iloc[idx],
    }


def _reference_ranks(ts, event_id: str) -> Optional[dict]:
    if ts.reference_ranks is None or event_id not in ts.reference_ranks.index:
        return None
    r = ts.reference_ranks.loc[event_id]
    return {c: int(r[f"rank_{c}"]) for c in te.CONDITIONS}


@app.get("/api/citation-search/test/meta")
def test_set_meta():
    try:
        ts, listing = _load_test_set()
    except (FileNotFoundError, ValueError) as e:
        return {"available": False, "error": str(e)}
    return {
        "available":       True,
        "n_queries":       int(len(listing)),
        "n_candidates":    int(ts.matrix.shape[1]),
        "result_limit":    TEST_RESULT_LIMIT,
        "intents":         {k: int(v) for k, v in listing["intent"].value_counts().items()},
        "fields":          [{"name": k, "count": int(v)}
                            for k, v in listing["field"].value_counts().sort_index().items()],
        "matrix_sha256":   ts.matrix_sha256,
        "reference_run_date": te.REFERENCE_RUN_DATE if ts.reference_ranks is not None else None,
        "stats":           ts.stats,
        "model":           cs.SCIBERT_MODEL,
        "alpha":           cs.ALPHA,
    }


def _word_start_pattern(tok: str) -> str:
    """Regex matching ``tok`` at the start of a word (plain substring if it starts with a symbol)."""
    esc = re.escape(tok)
    return rf"(?<!\w){esc}" if re.match(r"\w", tok) else esc


@app.get("/api/citation-search/test/queries")
def test_set_queries(
    q:      str = Query("", description="Words that must all appear in the citing title or context"),
    title:  str = Query("", description="Citing-paper title (whole text, or part of it)"),
    context: str = Query("", description="Citation context (whole text, or part of it)"),
    intent: str = Query(""),
    field:  str = Query(""),
    page:   int = Query(1, ge=1),
    limit:  int = Query(10, ge=1, le=50),
):
    ts, listing = _test_set_or_503()
    df = listing
    if intent in ALLOWED_INTENTS:
        df = df[df["intent"] == intent]
    if field:
        df = df[df["field"] == field]
    # Each word must start a word in the title or context ("stem" matches "stem", "stems",
    # "stemness", but not "system").
    # `q` (older links): every word must start a word in the title or context.
    for tok in _tokens(q):
        df = df[df["text_lc"].str.contains(_word_start_pattern(tok), regex=True)]
    # The query of a citation event is its full citing-paper title, full citation context and
    # intent: `title` and `context` are matched as whole texts
    # (case and spacing ignored), so the complete title or context finds its event.
    for col, text in (("title_lc", title), ("context_lc", context)):
        text = _norm_space(text)
        if text:
            df = df[df[col].str.contains(text, regex=False)]
    total = len(df)
    page_df = df.iloc[(page - 1) * limit: page * limit]
    return {
        "total": total, "page": page, "limit": limit,
        "total_pages": max(1, math.ceil(total / limit)),
        "results": [_test_query_out(ts, listing, int(i)) for i in page_df["idx"]],
    }


# The default example (event 194, Background): its context names neither the cited
# authors nor the year.
PAPER_EXAMPLE_IDX = 194


@lru_cache(maxsize=1)
def _example_indices() -> tuple:
    """One illustrative event per citation intent, chosen from the reference ranks.

    Each is an event whose cited paper is ranked first once the citation context is added
    (C2) and which gains the most ranks over the title alone (C1); among ties, a short, readable
    context that does not cite by author and year ("et al.", a year), so that the gain is not an
    author-name match with the candidate text. The Background example is the default
    example. These are chosen to illustrate the context effect and are not representative of
    the evaluation set.
    """
    ts, listing = _test_set_or_503()
    q = ts.queries
    df = pd.DataFrame({
        "idx":     np.arange(len(q)),
        "event":   q["citation_event_id"].astype(str).to_numpy(),
        "intent":  listing["intent"].to_numpy(),
        "ctx_len": listing["context"].str.len().to_numpy(),
        "ttl_len": listing["title"].str.len().to_numpy(),
    })
    paper_intent = df.loc[PAPER_EXAMPLE_IDX, "intent"] if PAPER_EXAMPLE_IDX < len(df) else None
    if ts.reference_ranks is not None:
        r = ts.reference_ranks.reindex(df["event"])
        df["c1"] = r["rank_C1"].to_numpy()
        df["c2"] = r["rank_C2"].to_numpy()
    else:
        df["c1"], df["c2"] = np.nan, np.nan
    df["gain"] = df["c1"] - df["c2"]
    # A context that starts as a sentence (capital letter), not mid-sentence.
    starts = listing["context"].str.match(r"[A-Z]").to_numpy()
    # The context must not name the cited work: no author-year citation ("Smith et al.", "2005"),
    # and neither the cited paper's first-author surname nor its year.
    def _names_cited(row) -> bool:
        ctx = unicodedata.normalize("NFKD", row["context"]).encode("ascii", "ignore").decode().lower()
        sur = unicodedata.normalize("NFKD", row["cited_author"].strip().split(" ")[0].rstrip(",.")) \
            .encode("ascii", "ignore").decode().lower() if row["cited_author"].strip() else ""
        if len(sur) > 1 and re.search(r"(?<![a-z])" + re.escape(sur) + r"(?![a-z])", ctx):
            return True
        y = row["cited_year"]
        return pd.notna(y) and re.search(r"(?<!\d)" + str(int(y)) + r"(?!\d)", ctx) is not None
    no_names = (~listing["context"].str.contains(r"et al|\b(?:19|20)\d{2}\b", regex=True)
                & ~listing.apply(_names_cited, axis=1)).to_numpy()
    readable = df["ctx_len"].between(60, 320) & (df["ttl_len"] <= 160) & starts & no_names
    out = []
    for intent in ALLOWED_INTENTS:
        if intent == paper_intent:
            out.append(PAPER_EXAMPLE_IDX)
            continue
        pool = df[(df["intent"] == intent) & readable]
        if pool.empty:
            pool = df[df["intent"] == intent]
        if pool.empty:
            continue
        best = pool[pool["c2"] == 1]
        if best.empty:
            best = pool
        best = best.sort_values(["gain", "ctx_len", "idx"], ascending=[False, True, True],
                                na_position="last")
        out.append(int(best["idx"].iloc[0]))
    return tuple(out)


@app.get("/api/citation-search/test/examples")
def test_set_examples():
    """Illustrative citation events to start from, one per intent (see _example_indices)."""
    ts, listing = _test_set_or_503()
    results = []
    for idx in _example_indices():
        item = _test_query_out(ts, listing, idx)
        item["reference_ranks"] = _reference_ranks(ts, item["citation_event_id"])
        item["paper_example"] = idx == PAPER_EXAMPLE_IDX
        results.append(item)
    return {"results": results}


@app.get("/api/citation-search/test/queries/{idx}")
def test_set_run(idx: int, condition: str = Query("C2")):
    ts, listing = _test_set_or_503()
    if not 0 <= idx < len(listing):
        raise HTTPException(status_code=404, detail="No such test query.")
    condition = condition.upper() if condition.upper() in te.CONDITIONS else "C2"
    ranked = _rank_test_query(idx)
    ids, _, meta, counts = _load_citation_index()
    cands = ts.matrix[idx]
    tpos = int(ts.target_pos[idx])
    query = _test_query_out(ts, listing, idx)

    def paper(pos: int) -> dict:
        row = int(cands[pos])
        out = _paper_out(meta, row)
        out.update({
            "candidate_position": pos,
            "is_cited":      pos == tpos,
            "ranks":         {c: int(ranked[c]["ranks"][pos]) for c in te.CONDITIONS},
            "scores":        {c: round(float(ranked[c]["scores"][pos]), 4) for c in te.CONDITIONS},
            "intent_counts": {i: int(counts.iloc[row][i]) for i in ALLOWED_INTENTS},
        })
        return out

    order = np.argsort(ranked[condition]["ranks"])[:TEST_RESULT_LIMIT]
    results = [paper(int(p)) for p in order]
    evidence = _citation_contexts([r["seed_paper_id"] for r in results], [query["intent"]],
                                  exclude_citing=str(query["citing_paper_id"]))
    for r in results:
        r["rank"] = r["ranks"][condition]
        r["evidence"] = {"contexts": evidence.get(r["seed_paper_id"], [])}

    cited = paper(tpos)
    ref = _reference_ranks(ts, query["citation_event_id"])
    return {
        "query":       query,
        "condition":   condition,
        "candidates":  int(len(cands)),
        "cited":       cited,
        "reference_ranks": ref,
        "matches_reference": None if ref is None else all(ref[c] == cited["ranks"][c] for c in te.CONDITIONS),
        "reference_run_date": te.REFERENCE_RUN_DATE if ref else None,
        "results":     results,
    }


@app.get("/api/citation-search/test/queries/{idx}/candidates.csv")
def test_set_csv(idx: int, condition: str = Query("C2")):
    """All 100 candidates of one test query with their live C1/C2/C3 scores and ranks."""
    ts, listing = _test_set_or_503()
    if not 0 <= idx < len(listing):
        raise HTTPException(status_code=404, detail="No such test query.")
    condition = condition.upper() if condition.upper() in te.CONDITIONS else "C2"
    ranked = _rank_test_query(idx)
    _, _, meta, _ = _load_citation_index()
    q = ts.queries.iloc[idx]
    cands = ts.matrix[idx]
    ref = _reference_ranks(ts, q["citation_event_id"]) or {}
    rows = []
    for pos, row in enumerate(cands):
        m = meta.iloc[int(row)]
        rows.append({
            "query_idx":          idx,
            "citation_event_id":  q["citation_event_id"],
            "citing_paper_id":    q["citing_paper_id"],
            "citing_title":       q["title_text"],
            "intent":             q["intent"],
            "citation_context":   q["context_text"],
            "candidate_position": pos,
            "seed_index":         int(row),
            "seed_paper_id":      m["seed_paper_id"],
            "doi":                m["doi"],
            "title":              m["title"],
            "journal":            m["journal"],
            "creator":            m["author"],
            "field":              m["field"],
            "year":               None if pd.isna(m["cover_year"]) else int(m["cover_year"]),
            "is_cited_target":    int(pos == ts.target_pos[idx]),
            **{f"score_{c}": round(float(ranked[c]["scores"][pos]), 6) for c in te.CONDITIONS},
            **{f"rank_{c}": int(ranked[c]["ranks"][pos]) for c in te.CONDITIONS},
            **{f"reference_rank_{c}": (ref.get(c) if pos == ts.target_pos[idx] else None)
               for c in te.CONDITIONS},
        })
    df = pd.DataFrame(rows).sort_values(f"rank_{condition}")
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    return Response(
        content="﻿" + buf.getvalue(),  # BOM so Excel opens UTF-8 correctly
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=citationhub_eval_query_{idx}.csv"},
    )


@app.get("/api/citation-search/replicate")
def citation_search_replicate(
    n:       int = Query(30, ge=5, le=100, description="Queries per selected intent"),
    intents: str = Query(""),
    field:   str = Query(""),
    seed:    int = Query(42),
):
    """Live controlled citation-recovery run.

    For real IDCite citation events, rank the actually cited seed paper among itself
    and 99 papers sampled from the same field (K = 100) under C1, C2 and C3, and report
    MRR / Hits@K / nDCG@10. Events are drawn from the example pool, not the held-out
    evaluation set, so the numbers are indicative rather than a reproduction.
    """
    ids, matrix, meta, _ = _citation_index_or_503()
    sel = _parse_intents(intents) or ALLOWED_INTENTS
    pool = _example_pool()
    pool = pool[pool["intent"].isin(sel)]
    if field:
        pool = pool[pool["field"] == field]
    rng = np.random.default_rng(seed)
    picked = pd.concat([g.sample(min(n, len(g)), random_state=seed) for _, g in pool.groupby("intent")]) \
        if not pool.empty else pool
    if picked.empty:
        raise HTTPException(status_code=404, detail="No citation events for this filter.")

    row_of = {sid: k for k, sid in enumerate(ids)}
    fields = meta["field"].to_numpy()
    by_field = {f: np.flatnonzero(fields == f) for f in pd.unique(fields)}

    try:
        encoder = cs.get_encoder()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"SciBERT encoder unavailable: {e}")

    titles = picked["citing_title"].tolist()
    contexts = picked["context"].tolist()
    conds = [cs.intent_conditioned_text(i, c) for i, c in zip(picked["intent"], contexts)]
    e_t = encoder.encode(titles)
    e_c = encoder.encode(contexts)
    e_ci = encoder.encode(conds)
    a = cs.ALPHA
    q = {"C1": e_t, "C2": cs._l2(e_t + a * e_c), "C3": cs._l2(e_t + a * e_ci)}

    rows = []
    for k, r in enumerate(picked.itertuples(index=False)):
        t = row_of.get(r.cited_seed_paper_id)
        if t is None:
            continue
        others = by_field[fields[t]]
        others = others[others != t]
        cand = np.concatenate([[t], rng.choice(others, size=min(99, len(others)), replace=False)])
        sub = matrix[cand]
        rk = {}
        for c in CONDITIONS:
            s = sub @ q[c][k]
            rk[c] = int(1 + np.sum(s > s[0]))
        rows.append({"intent": r.intent, "field": r.field, **rk})

    df = pd.DataFrame(rows)

    def metrics(frame):
        out = {}
        for c in CONDITIONS:
            rkc = frame[c].to_numpy()
            out[c] = {
                "mrr":    round(float(np.mean(1.0 / rkc)), 4),
                "hits1":  round(float(np.mean(rkc <= 1)), 4),
                "hits5":  round(float(np.mean(rkc <= 5)), 4),
                "hits10": round(float(np.mean(rkc <= 10)), 4),
                "ndcg10": round(float(np.mean(np.where(rkc <= 10, 1 / np.log2(rkc + 1), 0))), 4),
            }
        return out

    return {
        "n_queries":  int(len(df)),
        "candidates": 100,
        "alpha":      cs.ALPHA,
        "overall":    metrics(df),
        "by_intent":  [{"intent": i, "n": int(len(g)), **{c: round(float(np.mean(1.0 / g[c])), 4) for c in CONDITIONS}}
                       for i, g in df.groupby("intent")],
        "improved_c1_to_c3": int((df["C3"] < df["C1"]).sum()),
        "worse_c1_to_c3":    int((df["C3"] > df["C1"]).sum()),
    }


# ---------------------------------------------------------------------------
# SPARQL proxy -> internal QLever engine (localhost only; never exposed)
# ---------------------------------------------------------------------------
QLEVER_ENDPOINT  = os.environ.get("QLEVER_ENDPOINT", "http://localhost:7001")
SPARQL_MAX_LEN   = int(os.environ.get("SPARQL_MAX_LEN", "8000"))
SPARQL_TIMEOUT   = int(os.environ.get("SPARQL_TIMEOUT", "60"))

# Block any SPARQL Update / write operation; only read queries are allowed.
_SPARQL_FORBIDDEN = re.compile(
    r"\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|ADD|MOVE|COPY|WITH)\b",
    re.IGNORECASE,
)
_SPARQL_ALLOWED = re.compile(r"\b(SELECT|ASK|CONSTRUCT|DESCRIBE)\b", re.IGNORECASE)


class SparqlRequest(BaseModel):
    query: str


def _strip_sparql_comments(q: str) -> str:
    # remove line comments (# ...) so keyword checks aren't fooled
    return re.sub(r"#[^\n\r]*", "", q)


@app.post("/api/sparql")
def sparql_proxy(req: SparqlRequest):
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="Empty query.")
    if len(query) > SPARQL_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Query too long (max {SPARQL_MAX_LEN} characters).",
        )

    scrubbed = _strip_sparql_comments(query)
    if _SPARQL_FORBIDDEN.search(scrubbed):
        raise HTTPException(
            status_code=400,
            detail="Only read-only queries (SELECT / ASK / CONSTRUCT / DESCRIBE) are allowed.",
        )
    if not _SPARQL_ALLOWED.search(scrubbed):
        raise HTTPException(
            status_code=400,
            detail="Query must be a SELECT, ASK, CONSTRUCT or DESCRIBE.",
        )

    data = urllib.parse.urlencode({"query": query}).encode("utf-8")
    http_req = urllib.request.Request(
        QLEVER_ENDPOINT,
        data=data,
        headers={
            "Accept": "application/sparql-results+json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(http_req, timeout=SPARQL_TIMEOUT) as resp:
            body = resp.read()
            return Response(content=body, media_type="application/sparql-results+json")
    except urllib.error.HTTPError as e:
        try:
            err = e.read().decode("utf-8", "replace")
        except Exception:
            err = str(e)
        # surface QLever's parse / runtime error message to the user
        raise HTTPException(status_code=400, detail=err[:1000])
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"SPARQL engine unavailable: {e.reason}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"SPARQL engine error: {e}")
