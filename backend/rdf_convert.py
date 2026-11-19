"""
Convert the CitationHub knowledge graph (kg_nodes.parquet + kg_edges.parquet)
into an N-Triples file for loading into QLever (or any SPARQL engine).

Usage:
    python rdf_convert.py --data-dir /path/to/citationhub_data \
                          --out /path/to/citationhub-qlever/citationhub.nt
    # quick test on a subset:
    python rdf_convert.py --data-dir ./data --out sample.nt --limit 5000

Ontology (namespaces):
    resource IRIs : http://citationhub.org/id/<node_id>
    predicates    : http://citationhub.org/ontology/<predicate>
    classes       : http://citationhub.org/ontology/<Class>
    rdf:type      : http://www.w3.org/1999/02/22-rdf-syntax-ns#type
    rdfs:label    : http://www.w3.org/2000/01/rdf-schema#label
"""
from __future__ import annotations

import argparse
import os
import math

import pyarrow.parquet as pq

BASE_ID   = "http://citationhub.org/id/"
BASE_ONT  = "http://citationhub.org/ontology/"
RDF_TYPE  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
XSD_INT   = "http://www.w3.org/2001/XMLSchema#integer"
XSD_BOOL  = "http://www.w3.org/2001/XMLSchema#boolean"

# edge_type -> predicate local name
EDGE_PRED = {
    "HAS_CITED_PAPER":    "hasCitedPaper",
    "HAS_CITING_PAPER":   "hasCitingPaper",
    "HAS_PRIMARY_INTENT": "hasPrimaryIntent",
    "PUBLISHED_IN_VENUE": "publishedInVenue",
    "PUBLISHED_IN":       "publishedIn",
    "BELONGS_TO_FIELD":   "belongsToField",
    "HAS_AUTHOR":         "hasAuthor",
    "HAS_AFFILIATION":    "hasAffiliation",
    "LOCATED_IN_CITY":    "locatedInCity",
    "LOCATED_IN_COUNTRY": "locatedInCountry",
}

# node_type -> class local name
NODE_CLASS = {
    "seed_paper":     "SeedPaper",
    "citing_paper":   "CitingPaper",
    "citation_event": "CitationEvent",
    "author":         "Author",
    "journal":        "Journal",
    "affiliation":    "Affiliation",
    "city":           "City",
    "country":        "Country",
    "intent":         "Intent",
    "field":          "Field",
}

# IRI-illegal characters in N-Triples IRIREF -> percent-encode
_IRI_BAD = set(' <>"{}|^`\\') | {chr(c) for c in range(0x00, 0x21)}

def iri_local(node_id: str) -> str:
    out = []
    for ch in str(node_id):
        if ch in _IRI_BAD:
            out.append("%%%02X" % ord(ch))
        else:
            out.append(ch)
    return BASE_ID + "".join(out)

def esc_literal(s: str) -> str:
    return (str(s).replace("\\", "\\\\").replace('"', '\\"')
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"))

def _is_empty(v) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    s = str(v).strip()
    return s == "" or s.lower() == "nan" or s.lower() == "none"

def _int_lit(v):
    try:
        if _is_empty(v):
            return None
        return str(int(float(v)))
    except (ValueError, TypeError):
        return None

# kg_nodes columns -> (predicate local name, kind)  kind in {str,int,bool}
NODE_PROPS = [
    ("doi",              "doi",             "str"),
    ("publication_name", "publicationName", "str"),
    ("group",            "fieldGroup",      "str"),
    ("venue",            "venue",           "str"),
    ("category_raw",     "category",        "str"),
    ("primary_intent",   "primaryIntent",   "str"),
    ("citedby_count",    "citedbyCount",    "int"),
    ("year",             "year",            "int"),
    ("context_count",    "contextCount",    "int"),
    ("intent_count",     "intentCount",     "int"),
    ("is_influential",   "isInfluential",   "bool"),
]


def convert(data_dir: str, out_path: str, limit: int = 0, batch: int = 200_000):
    nodes_path = os.path.join(data_dir, "kg_nodes.parquet")
    edges_path = os.path.join(data_dir, "kg_edges.parquet")

    n_triples = 0
    with open(out_path, "w", encoding="utf-8", newline="\n") as out:
        # ---- nodes ----
        node_cols = ["node_id", "node_type", "label"] + [c for c, _, _ in NODE_PROPS]
        avail = set(pq.read_schema(nodes_path).names)
        node_cols = [c for c in node_cols if c in avail]
        prop_defs = [(c, p, k) for (c, p, k) in NODE_PROPS if c in avail]

        pf = pq.ParquetFile(nodes_path)
        seen = 0
        buf = []
        for rb in pf.iter_batches(batch_size=batch, columns=node_cols):
            d = rb.to_pydict()
            ids = d["node_id"]
            for i in range(len(ids)):
                nid = ids[i]
                if _is_empty(nid):
                    continue
                subj = "<%s>" % iri_local(nid)

                ntype = d.get("node_type", [None]*len(ids))[i]
                cls = NODE_CLASS.get(str(ntype))
                if cls:
                    buf.append("%s <%s> <%s%s> .\n" % (subj, RDF_TYPE, BASE_ONT, cls))
                    n_triples += 1

                lab = d.get("label", [None]*len(ids))[i]
                if not _is_empty(lab):
                    buf.append('%s <%s> "%s" .\n' % (subj, RDFS_LABEL, esc_literal(lab)))
                    n_triples += 1

                for col, pred, kind in prop_defs:
                    v = d[col][i]
                    if _is_empty(v):
                        continue
                    if kind == "str":
                        buf.append('%s <%s%s> "%s" .\n' % (subj, BASE_ONT, pred, esc_literal(v)))
                        n_triples += 1
                    elif kind == "int":
                        iv = _int_lit(v)
                        if iv is not None:
                            buf.append('%s <%s%s> "%s"^^<%s> .\n' % (subj, BASE_ONT, pred, iv, XSD_INT))
                            n_triples += 1
                    elif kind == "bool":
                        bv = "true" if (v is True or str(v).lower() == "true") else (
                             "false" if (v is False or str(v).lower() == "false") else None)
                        if bv is not None:
                            buf.append('%s <%s%s> "%s"^^<%s> .\n' % (subj, BASE_ONT, pred, bv, XSD_BOOL))
                            n_triples += 1
                seen += 1
                if limit and seen >= limit:
                    break
            if len(buf) >= 500_000:
                out.write("".join(buf)); buf = []
            if limit and seen >= limit:
                break
        if buf:
            out.write("".join(buf)); buf = []
        print(f"nodes processed: {seen}")

        # ---- edges ----
        pf = pq.ParquetFile(edges_path)
        seen = 0
        buf = []
        for rb in pf.iter_batches(batch_size=batch, columns=["source", "target", "edge_type"]):
            d = rb.to_pydict()
            src, tgt, et = d["source"], d["target"], d["edge_type"]
            for i in range(len(src)):
                pred = EDGE_PRED.get(str(et[i]))
                if pred is None or _is_empty(src[i]) or _is_empty(tgt[i]):
                    continue
                buf.append("<%s> <%s%s> <%s> .\n" % (
                    iri_local(src[i]), BASE_ONT, pred, iri_local(tgt[i])))
                n_triples += 1
                seen += 1
                if limit and seen >= limit:
                    break
            if len(buf) >= 500_000:
                out.write("".join(buf)); buf = []
            if limit and seen >= limit:
                break
        if buf:
            out.write("".join(buf))
        print(f"edges processed: {seen}")

    print(f"total triples written: {n_triples}")
    print(f"output: {out_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, help="folder with kg_nodes.parquet & kg_edges.parquet")
    ap.add_argument("--out", required=True, help="output .nt path")
    ap.add_argument("--limit", type=int, default=0, help="limit rows per table (0 = all, for testing)")
    args = ap.parse_args()
    convert(args.data_dir, args.out, args.limit)
