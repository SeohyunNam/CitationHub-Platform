"""Citation search: citation-context-aware ranking + SciERC-style annotation.

Ranking:

* every text is encoded by a frozen SciBERT encoder with attention-mask-aware mean
  pooling and L2 normalisation, max 256 tokens;
* a candidate seed paper is encoded once from its bibliographic metadata
  (title, publication name, creator, multidisciplinary group, category, joined with
  [SEP]);
* the query is built incrementally:
      C1 = e_t                                  (title only)
      C2 = norm(e_t + 0.75 * e_c)                (title + context)
      C3 = norm(e_t + 0.75 * e_{c,i})            (title + intent-conditioned context)
  where e_{c,i} encodes "Citation function: i. d_i [SEP] Citation context: x_c"
  with the natural-language intent descriptions d_i below;
* candidates are scored by s(e, p) = q_e . d_p, i.e. cosine similarity.

When several intents are selected, C3 scores a paper by its best-matching intent
(max over the intent-conditioned queries).
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

SCIBERT_MODEL = "allenai/scibert_scivocab_uncased"
MAX_LEN = 256
ALPHA = 0.75  # context-fusion coefficient, chosen on validation MRR

EMBEDDINGS_FILE = "seed_scibert_embeddings.npy"
EMBEDDING_IDS_FILE = "seed_scibert_ids.txt"

# Concise natural-language description of each citation function.
INTENT_DESCRIPTIONS = {
    "background":   "The cited work provides background knowledge or prior information relevant to this research.",
    "motivation":   "The cited work motivates the research problem or provides a reason for conducting this research.",
    "uses":         "The current research uses a method, dataset, tool, resource, or approach from the cited work.",
    "extends":      "The current research extends, improves, or builds upon the cited work.",
    "similarities": "The cited work has similar methods, findings, ideas, or approaches to the current research.",
    "differences":  "The cited work differs from or contrasts with the current research.",
    "future_work":  "The cited work is relevant to a future research direction or further investigation.",
}


def intent_label(intent: str) -> str:
    return intent.replace("_", " ")


def intent_conditioned_text(intent: str, context: str) -> str:
    """x_{c,i} = "Citation function: i. d_i [SEP] Citation context: x_c".

    The intent is written as its id (e.g. ``future_work``), as in the offline
    evaluation, so that C3 scores reproduce the saved reference ranks.
    """
    return (f"Citation function: {intent}. {INTENT_DESCRIPTIONS[intent]} "
            f"[SEP] Citation context: {context}")


def candidate_text(title, publication, creator, group, category) -> str:
    """Candidate text: non-empty metadata fields joined by separator tokens."""
    parts = [str(x).strip() for x in (title, publication, creator, group, category)]
    return " [SEP] ".join(p for p in parts if p and p.lower() != "nan")


def _l2(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.clip(n, 1e-12, None)


class SciBertEncoder:
    """Frozen SciBERT, mean pooling over the attention mask, L2-normalised output."""

    def __init__(self, model_name: str = SCIBERT_MODEL):
        import torch
        from transformers import AutoModel, AutoTokenizer

        self._torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name)
        self.model.eval()
        self._lock = threading.Lock()

    def encode(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        torch = self._torch
        out = []
        with self._lock, torch.inference_mode():
            for i in range(0, len(texts), batch_size):
                batch = self.tokenizer(
                    texts[i:i + batch_size], padding=True, truncation=True,
                    max_length=MAX_LEN, return_tensors="pt",
                )
                hidden = self.model(**batch).last_hidden_state          # (B, L, 768)
                mask = batch["attention_mask"].unsqueeze(-1).float()    # (B, L, 1)
                pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                out.append(pooled.cpu().numpy().astype(np.float32))
        if not out:
            return np.zeros((0, 768), dtype=np.float32)
        return _l2(np.concatenate(out))


_encoder: SciBertEncoder | None = None
_encoder_lock = threading.Lock()


def get_encoder() -> SciBertEncoder:
    global _encoder
    with _encoder_lock:
        if _encoder is None:
            _encoder = SciBertEncoder()
        return _encoder


def load_candidate_index(data_dir: Path):
    """Returns (ids: list[str], matrix: float32 (N, 768)) or raises FileNotFoundError."""
    emb_path = data_dir / EMBEDDINGS_FILE
    ids_path = data_dir / EMBEDDING_IDS_FILE
    if not emb_path.exists() or not ids_path.exists():
        raise FileNotFoundError(
            f"{EMBEDDINGS_FILE} not found in {data_dir}. "
            "Run scripts/build_citation_search_index.py first.")
    matrix = np.load(emb_path).astype(np.float32, copy=False)
    ids = ids_path.read_text(encoding="utf-8").splitlines()
    if len(ids) != matrix.shape[0]:
        raise ValueError("Embedding ids and matrix row counts differ; rebuild the index.")
    return ids, matrix


def build_queries(encoder: SciBertEncoder, title: str, context: str,
                  intents: list[str], alpha: float = ALPHA) -> dict:
    """Query vectors for C1, C2 and C3 (one C3 vector per selected intent).

    A missing title or context contributes a zero vector, so a query with only a
    context still works (C1 is then undefined and reported as None).
    """
    title, context = title.strip(), context.strip()
    texts, keys = [], []
    if title:
        texts.append(title); keys.append("t")
    if context:
        texts.append(context); keys.append("c")
        for i in intents:
            texts.append(intent_conditioned_text(i, context)); keys.append(f"ci:{i}")
    vecs = dict(zip(keys, encoder.encode(texts))) if texts else {}
    zero = np.zeros(768, dtype=np.float32)
    e_t = vecs.get("t", zero)

    q = {"C1": e_t[None, :] if title else None}
    q["C2"] = _l2((e_t + alpha * vecs["c"])[None, :]) if context else q["C1"]
    if context and intents:
        q["C3"] = _l2(np.stack([e_t + alpha * vecs[f"ci:{i}"] for i in intents]))
    else:
        q["C3"] = q["C2"]
    return q


def score(query: np.ndarray | None, matrix: np.ndarray) -> np.ndarray | None:
    """Cosine scores; with several query rows (one per intent) keep the best."""
    if query is None:
        return None
    return (matrix @ query.T).max(axis=1)


def ranks_from_scores(scores: np.ndarray) -> np.ndarray:
    """1-based rank of every row (higher score = better rank)."""
    order = np.argsort(-scores, kind="stable")
    r = np.empty_like(order)
    r[order] = np.arange(1, len(order) + 1)
    return r
