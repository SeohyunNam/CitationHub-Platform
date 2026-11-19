# CitationHub

An academic citation-analytics web application that lets users search seed papers, explore
their citation events, and visualize the relationships between papers, authors, institutions,
and research fields. The UI is inspired by the CORE academic search experience.

**Live site:** https://citation-hub-website.vercel.app

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Citation Search](#citation-search)
- [Project Structure](#project-structure)
- [Backend API Reference](#backend-api-reference)
- [Data Files](#data-files)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [License](#license)

---

## Overview

CitationHub is built on a dataset of ~23,000 seed papers and ~1.8 million citation events.
For each seed paper it records *who* cited it, *why* they cited it (citation intent), and the
metadata of both the seed and citing papers. The application exposes this through a fast search
interface and several interactive visualizations.

| Metric | Value |
|--------|-------|
| Seed papers | ~23,479 |
| Citation events | ~1,831,889 |
| Distinct citing papers | ~1,446,205 |
| Authors | ~16,839 |
| Journals | 232 |
| Countries | 108 |
| Research fields | 21 |
| Citation intents | 7 (`background`, `uses`, `similarities`, `motivation`, `differences`, `future_work`, `extends`) |

---

## Architecture

The application is split into a statically hosted Next.js frontend and a FastAPI backend that
reads the dataset as local Parquet files.

```
                    Browser (user)
                          |
                          v
        Next.js frontend (e.g. Vercel)
                          |
                          |  NEXT_PUBLIC_API_URL  (HTTPS)
                          v
        Backend server
        |
        ├── FastAPI / uvicorn                       (REST API)
        |     ├── reads $CITATIONHUB_DATA_DIR/*.parquet   (pandas + DuckDB)
        |     ├── Citation search: SciBERT encoder (CPU, in-process)
        |     |     + seed_scibert_embeddings.npy, seed_scibert_ids.txt
        |     └── /api/sparql  ──proxy──►  QLever  (read-only)
        |
        └── QLever (Docker)                          (SPARQL engine, ~25M triples,
                                                      internal only)
```

---

## Tech Stack

### Frontend
- **Next.js 14** (Pages Router) + **React 18**
- **Tailwind CSS** for styling
- **react-force-graph-2d** – Knowledge Graph & Citation Network visualizations (canvas-based)
- **react-simple-maps** + **d3-scale** – world map (country choropleth, city and affiliation bubbles)
- **Recharts** – analytics charts
- **SWR** – client-side data fetching

### Backend
- **FastAPI** + **uvicorn**
- **pandas** + **pyarrow** – Parquet reading and search/aggregation
- **DuckDB** – SQL queries over large Parquet files (citation events)
- **networkx** – graph helpers
- **PyTorch** + **Hugging Face Transformers** – frozen SciBERT encoder for Citation search
  (CPU inference; `backend/citation_search.py`)
- **QLever** (in Docker) – SPARQL engine serving the RDF knowledge graph; the backend
  proxies read-only queries to it via `/api/sparql` (the QLever port stays internal)

---

## Features

| Page | Route | Description |
|------|-------|-------------|
| Home | `/` | Dataset statistics and paper/author search |
| Search | `/search` | Keyword search over titles/DOIs with field, country and journal filters, pagination and CSV export |
| Advanced search | `/search/advanced` | Fielded search by keywords, title, author, journal and publication-year range |
| Citation search | `/search/citation` | Citation-context-aware ranking of candidate papers for a citation event (see [Citation Search](#citation-search)) |
| Author search / detail | `/authors`, `/authors/[id]` | Author search grouped by `author_id`; profile with intent distribution, citations over time and top citing venues |
| Paper detail | `/papers/[id]` | Citation-intent distribution, citing papers, co-cited papers, CSV export, link to the Knowledge Graph |
| Knowledge Graph | `/kg` | Interactive graph of a seed paper and its journals, authors, affiliations, places, fields and citation events, with the ontology diagram |
| Citation Network | `/network` | Network of a seed paper and its citing papers, colored and filterable by citation intent |
| Geographic Map | `/geo` | World map with country choropleth, city bubbles and affiliation bubbles |
| Analytics | `/analytics` | Citation-intent trends, intent distribution, influential-citation ratio and top venues |
| SPARQL | `/sparql` | Read-only SPARQL over the ~25M-triple knowledge graph (QLever), with example queries and CSV export |

---

## Citation Search

Citation search ranks seed papers for a citation event: given the citing paper's title, the
citation context (the citing sentence) and the citation intent, it scores same-field candidate
papers and shows where the actually cited paper ranks, together with the IDCite citation
contexts that support each result. The page runs on a fixed evaluation set of citation events,
each with 100 candidates; the free-text endpoint `/api/citation-search` ranks any title/context.

### Ranking method

Implemented in `backend/citation_search.py` (encoder, texts) and `backend/eval_set.py`
(evaluation-set ranking).

1. **Encoder.** A frozen SciBERT model (`allenai/scibert_scivocab_uncased`). Each text (max 256
   tokens) is mean-pooled over the attention mask and L2-normalized:

   ```
   e(x) = norm( Σ_j m_j h_j / Σ_j m_j )        h_j ∈ R^768, m_j ∈ {0,1}
   ```

2. **Candidate papers.** Each seed paper p is encoded once, offline, from its metadata:

   ```
   d_p = e( title [SEP] publication name [SEP] creator [SEP] group [SEP] category )
   ```

3. **Query and score.** The title x_t and citation context x_c are encoded separately and
   fused; candidates are scored by cosine similarity s(q, p) = q · d_p.

| Condition | Query |
|-----------|-------|
| C1 | `e(x_t)` — title only |
| **C2** (default) | `norm(e(x_t) + 0.75 · e(x_c))` — title + citation context |
| C3 | `norm(e(x_t) + 0.75 · e(x_c,i))` — title + intent-conditioned context |

C3 prefixes the context with the intent and a short description d_i
(`"Citation function: <i>. <d_i> [SEP] Citation context: <x_c>"`; descriptions in
`INTENT_DESCRIPTIONS`). In C2 the intent is not part of the query; it restricts the candidates
to papers cited with that intent and selects the evidence contexts shown.

### Evaluation set

Read from `$CITATIONHUB_DATA_DIR/eval_set/`:

| File | Content |
|------|---------|
| `test_queries_1975.parquet` | Test citation events: `citation_event_id`, `citing_paper_id`, `target_seed_id`, `target_field_id`, `intent`, `title_text`, `context_text` |
| `test_candidate_matrix.npy` | (events × 100) candidate seed papers, as row numbers of `seed_cited_papers_normalized.parquet` |
| `reference_ranks.csv` | Optional. Reference ranks of the cited paper, shown next to the live ranks |

The files are generated from the IDCite Parquet files by
[`extract_candidates.py`](https://github.com/SeohyunNam/CitationHub-System/blob/main/scripts/extract_candidates.py)
(seed 42): one event per citing paper and intent, the cited paper plus 99 same-field seed
papers. Without them the rest of the site works and the page shows a notice.

### Index

`scripts/build_citation_search_index.py` writes `seed_scibert_embeddings.npy` (N × 768) and
`seed_scibert_ids.txt` into the data directory (about 15 minutes on CPU; downloads SciBERT,
~440 MB, on first run). The backend loads the index and the model in the background at startup;
a query takes about 3 seconds on CPU.

`scripts/check_conditions.py` prints ranks and scores under C1/C2/C3 for an example query, and
`GET /api/citation-search/replicate` runs a citation-recovery test (MRR, Hits@k, nDCG@10).

---

## Project Structure

```
CitationHub-Platform/
├── backend/
│   ├── main.py            # FastAPI app: all API endpoints + data loading
│   ├── citation_search.py # Citation search: SciBERT encoder + citation-context-aware ranking
│   ├── eval_set.py        # Citation search evaluation set: loading, checks, live ranking
│   ├── rdf_convert.py     # kg_nodes/kg_edges Parquet → N-Triples (for QLever)
│   ├── data/
│   │   └── city_coords.json   # (city, country) → lat/lon for the map's point layers
│   ├── qlever/
│   │   └── Qleverfile     # QLever index/server configuration
│   ├── requirements.txt
│   └── Dockerfile
├── scripts/
│   ├── build_geo_points.py    # geocodes the dataset's cities via GeoNames
│   ├── build_citation_search_index.py  # SciBERT vectors of all seed papers (Citation search)
│   └── check_conditions.py    # prints Citation search ranks/scores under C1, C2, C3
├── frontend/
│   ├── pages/
│   │   ├── index.jsx          # Home (stats + search bar)
│   │   ├── search.jsx         # Paper search results
│   │   ├── search/advanced.jsx# Advanced (fielded) paper search form
│   │   ├── search/citation.jsx# Citation search (context + intent aware recommendation)
│   │   ├── authors.jsx        # Author search results
│   │   ├── authors/[id].jsx   # Author detail + citation pattern charts
│   │   ├── papers/[id].jsx    # Paper detail
│   │   ├── kg.jsx             # Knowledge Graph + ontology
│   │   ├── network.jsx        # Citation Network
│   │   ├── geo.jsx            # Geographic Map
│   │   ├── analytics.jsx      # Analytics dashboard
│   │   ├── sparql.jsx         # SPARQL explorer
│   │   └── _app.jsx
│   ├── components/
│   │   ├── Layout.jsx         # Navigation + footer
│   │   ├── SearchBar.jsx
│   │   ├── SearchTabs.jsx     # Advanced / Citation search tab switcher
│   │   ├── PaperCard.jsx
│   │   ├── ForceGraph.jsx     # react-force-graph-2d wrapper (KG + Network)
│   │   └── ChoroplethMap.jsx  # react-simple-maps world map (countries/cities/affiliations)
│   ├── lib/
│   │   ├── searchQuery.js     # shared search query-string helpers (simple + advanced)
│   │   └── mapLayer.js        # bubble sizing, cluster fan-out, country/city/affiliation labels
│   ├── public/
│   │   └── data/geo_points.json   # fallback map points (see Geographic Map data)
│   ├── styles/globals.css
│   ├── next.config.js
│   ├── tailwind.config.js
│   ├── vercel.json
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Backend API Reference

Base URL = the backend's public address (set as `NEXT_PUBLIC_API_URL` in the frontend).
All responses are JSON unless noted.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check → `{"status":"ok"}` |
| GET | `/api/overview` | Dataset statistics and filter option lists |
| GET | `/api/search` | Search papers. Query params: `q` (title/DOI keywords), `title`, `author`, `journal`, `field`, `country`, `year_min`, `year_max` (seed cover year), `page`, `limit`. Filled text fields are ANDed; tokens within a field are also ANDed. |
| GET | `/api/papers/{seed_paper_id}` | Paper detail: intents, citing papers, co-cited papers, contexts, `total_events`, `unique_citing`. Params: `intents` (comma-separated; empty = every event with one of the seven intents, including two-label events; with a filter, any event carrying a selected label; intent counts count each label of an event), `limit` (citing papers returned, default 30, ≤2000), `cocited_limit` (co-cited papers returned, default 15, ≤100; `cocited_total` gives the full count), `year_min`, `year_max` (citing year; no limit by default) |
| GET | `/api/citing/{seed_paper_id}` | One page of a paper's citing papers, most citation contexts first. Params: `page` (from 1), `limit` (default 20, ≤100), `intents` (same rule as `/api/papers`). Returns `total`, `page`, `limit`, `total_pages`, `results` |
| GET | `/api/cocited/{seed_paper_id}` | One page of the seed papers co-cited with a paper, most co-citations first. Params: `page`, `limit` (default 20, ≤100). Same response shape as `/api/citing` |
| GET | `/api/citation-search` | Citation-context-aware ranking. Params: `title`, `context` (at least one), `intents`, `field`, `condition` (`C1`/`C2`/`C3`, default `C2`), `require_intent` (default true), `target` (seed id to report the rank of), `limit`. Returns ranked papers with C1/C2/C3 scores and ranks and the citation contexts that cite each one with the selected intents. |
| GET | `/api/citation-search/meta` | Index status, fields, intents (with their descriptions), conditions, and `candidate_masks`: `{field: {intent bitmask: number of papers}}` (bit k = k-th entry of `intents`), from which the page computes the live candidate count |
| GET | `/api/citation-search/example` | A real IDCite citation event (title, context, intent, cited seed id) to use as a query. Params: `intent`, `field`, `n` |
| GET | `/api/citation-search/test/meta` | Evaluation set status: number of events and candidates, events per intent and field, SHA-256 of the candidate matrix |
| GET | `/api/citation-search/test/queries` | Test citation events. Params: `q` (words in citing title or context), `intent`, `field`, `page`, `limit` (≤50) |
| GET | `/api/citation-search/test/queries/{idx}` | Live ranking of one event's 100 candidates. Param: `condition` (`C1`/`C2`/`C3`, default `C2`). Returns the event, the cited paper with its C1/C2/C3 ranks, and the top 10 with evidence contexts |
| GET | `/api/citation-search/test/queries/{idx}/candidates.csv` | All 100 candidates with metadata, `is_cited_target`, scores and ranks under C1/C2/C3 (UTF-8 CSV with BOM). Param: `condition` sets the sort order |
| GET | `/api/citation-search/replicate` | Live controlled citation-recovery run: MRR, Hits@1/5/10, nDCG@10 for C1/C2/C3 over K = 100 same-field candidates. Params: `n` (per intent, ≤100), `intents`, `field`, `seed` |
| GET | `/api/authors/search` | Search authors by name (token-based). Params: `q`, `page`, `limit`. Authors grouped by `author_id`. |
| GET | `/api/authors/{author_id}` | Author profile + list of the author's seed papers |
| GET | `/api/authors/{author_id}/analytics` | Author citation patterns: intent distribution, citations over time, top citing venues |
| GET | `/api/kg/{seed_paper_id}` | Knowledge-graph nodes and edges for a paper |
| GET | `/api/geo` | Country/city/affiliation counts, plus the map's bubble layers: `city_points` (one entry per city, with `lat`, `lon` and paper count) and `affiliation_points` (the 800 busiest affiliations, each on its city's coordinates) |
| GET | `/api/analytics` | Intent trends, top venues, influential ratio, global intent distribution |
| POST | `/api/sparql` | Proxy a read-only SPARQL query to the internal QLever engine. Body: `{"query": "..."}`. Returns SPARQL JSON results. Update operations (INSERT/DELETE/…) are rejected. |
| GET | `/api/export/search` | CSV export of search results. Same filter params as `/api/search` (except `page`/`limit`). |
| GET | `/api/export/paper/{seed_paper_id}` | CSV export of a paper's citation events with `citation_event_id` and contexts (joined by ` \|\| `). Param: `intents` (same rule as `/api/papers`) |

> `seed_paper_id` values can contain slashes (DOIs), so the routes use FastAPI's `:path`
> converter.

### Data source switch

The backend chooses its data source based on environment variables:

- If `HF_REPO_ID` is **empty** → reads local Parquet files from `CITATIONHUB_DATA_DIR`
  (recommended).
- If `HF_REPO_ID` is **set** → downloads the files from that Hugging Face dataset repository
  (`HF_TOKEN` is needed if it is private).

---

## Data Files

### Getting the data

The dataset is not included in this repository. The code is published so the system can be
inspected and reused; to run it you need the IDCite Parquet dataset. Then:

1. Place the Parquet files below in a folder on the server that runs the backend.
2. Set `CITATIONHUB_DATA_DIR` to that folder and leave `HF_REPO_ID` empty (see `.env.example`).
3. Build the SciBERT index with `scripts/build_citation_search_index.py` and, optionally, the
   Citation search evaluation set (see [Evaluation set](#evaluation-set)).

### Expected files

The backend expects these Parquet files in `CITATIONHUB_DATA_DIR`:

| File | Purpose |
|------|---------|
| `seed_cited_papers_normalized.parquet` | Seed paper metadata (small, ~23K rows); also the source for author search/aggregation |
| `citation_events_normalized.parquet` | Citation events (large, ~1.8M rows) |
| `kg_nodes.parquet` | Knowledge-graph nodes |
| `kg_edges.parquet` | Knowledge-graph edges (used to build the RDF/SPARQL graph) |
| `authors.parquet` | Author lookup (`author_id` → name) |
| `eval_set/` | Optional. Citation search evaluation set (see [Evaluation set](#evaluation-set)) |
| `seed_scibert_embeddings.npy`, `seed_scibert_ids.txt` | SciBERT index for Citation search, built by `scripts/build_citation_search_index.py` (see [Index](#index)) |

(Additional Parquet files in the folder are ignored.)

### Geographic Map data

The dataset records affiliations' cities and countries by name only, so coordinates are kept in
the repository: `backend/data/city_coords.json` maps `(city, country)` to `lat`/`lon` for
`/api/geo`, and `frontend/public/data/geo_points.json` is a static fallback for the map.
Both are generated offline by `scripts/build_geo_points.py` from
[GeoNames](https://www.geonames.org) (`cities500`, `countryInfo`; CC BY 4.0):

```bash
python scripts/build_geo_points.py \
  --seed $CITATIONHUB_DATA_DIR/seed_cited_papers_normalized.parquet \
  --geonames /path/to/geonames
```

---

## Local Development

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Point to a local folder containing the Parquet files
export CITATIONHUB_DATA_DIR=/path/to/citationhub_data
export HF_REPO_ID=                # leave empty to use local files
uvicorn main:app --reload --port 8000
```

On a machine without a GPU, install the CPU build of PyTorch first
(`pip install torch --index-url https://download.pytorch.org/whl/cpu`). Citation search also
needs the SciBERT index (see [Index](#index)).

### 2. Frontend

```bash
cd frontend
npm install --legacy-peer-deps
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Open http://localhost:3000

---

## Deployment

The frontend and backend are deployed separately. The browser calls the backend directly, so
the backend must be reachable over **HTTPS** when the frontend is served over HTTPS.

### Backend

1. **Prepare the data** on the server as described in [Getting the data](#getting-the-data)
   and set `CITATIONHUB_DATA_DIR` to that folder (see `.env.example`).
2. **Install and build the Citation search index** (CPU-only PyTorch is enough):

   ```bash
   cd backend
   python3 -m venv venv && source venv/bin/activate
   pip install torch --index-url https://download.pytorch.org/whl/cpu
   pip install -r requirements.txt
   python ../scripts/build_citation_search_index.py --data-dir "$CITATIONHUB_DATA_DIR"
   ```

3. **Run the API**, e.g. as a service behind a reverse proxy or tunnel that terminates HTTPS:

   ```bash
   uvicorn main:app --host 127.0.0.1 --port 8000
   ```

   Alternatively, `docker compose up --build` runs the backend and frontend together.
   After a restart the backend warms the SciBERT index in the background for a minute or two;
   `GET /api/citation-search/meta` reports `index_ready: true` once it is ready. The SciBERT
   model needs roughly 1 GB of RAM on top of the loaded data.

4. **(Optional) SPARQL.** The `/sparql` page needs a QLever instance. Convert the knowledge
   graph and start QLever with the configuration in `backend/qlever/Qleverfile` (set your own
   `ACCESS_TOKEN` there first):

   ```bash
   python backend/rdf_convert.py --data-dir "$CITATIONHUB_DATA_DIR" --out backend/qlever/citationhub.nt
   cd backend/qlever && qlever index && qlever start      # SPARQL on 127.0.0.1:7001
   ```

   Keep the QLever port internal; the backend proxies read-only queries via `/api/sparql`.

### Frontend

Deploy `frontend/` to any Next.js host (e.g. Vercel, using `frontend/vercel.json`) and set
**`NEXT_PUBLIC_API_URL`** to the backend's public HTTPS URL, with no trailing slash and no
`/api` suffix. The value is inlined at build time, so redeploy after changing it.

---

## License

Released under the [MIT License](LICENSE).
