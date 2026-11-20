# Requirements

This page states what CitationHub must do (functional requirements, FR) and the qualities and
constraints under which it must do it (non-functional requirements, NFR), how they were written,
and how each one is verified. The verification scripts are in
[`scripts/verification/`](../scripts/verification/).

## How the requirements were derived

The requirements follow from three design goals and, for Citation search, from the design of the
evaluation set and the three ranking conditions (C1, C2, C3). They were specified from these goals
rather than elicited from users, and were written down after the first implementation of the
system. The implemented system is then verified against every requirement (see
[Verification](#verification)).

**Design goals**

1. **Exploration.** Make the IDCite resource accessible through search, author, analytics,
   geographic, citation-network, knowledge-graph, and SPARQL views over the same data.
2. **Citation-level evidence.** Expose, for each paper, the citation contexts and citation
   functions with which it has been cited, so that its use by other authors can be inspected
   rather than inferred from a citation count.
3. **Verifiable demonstration of Citation search.** Let users inspect how candidates are ranked for
   individual citation events, in a form that can be checked against the observed citation and
   reproduced from public data.

**Use cases** (goal-level use cases [5], each naming the goal a user pursues)

| ID | Use case | Goal |
|---|---|---|
| UC1 | Inspect how a paper has actually been cited: with which functions and in which citation contexts | 2 |
| UC2 | For one citation event, see how the rank of the cited paper changes as the title, the citation context, and the citation intent are added to the query | 3 |
| UC3 | Check a ranking against the observed citation and trace it to its source record | 3 |
| UC4 | Find a citation event of interest without knowing its full text | 3 |
| UC5 | Explore citation intents across fields, authors, venues, places, and entities | 1 |
| UC6 | Query the scholarly entities and citation events directly, for analyses the views do not provide | 1 |

## How the requirements are written

- **Form.** Each requirement follows ISO/IEC/IEEE 29148 [1]: it is a single verifiable condition
  ("the system shall …") with a unique identifier, traced to the use case and the goal or design
  decision that motivates it, and checked against a verification criterion [4].
- **Functional and non-functional.** Requirements are divided into what the system must do and the
  qualities and constraints under which it must do it [3].
- **Qualities.** Each NFR is named after the product-quality characteristic of ISO/IEC 25010 [2]
  that it belongs to. Reproducibility, verifiability, and transparency are added because Citation
  search is used to inspect and check rankings ("research use"); data locality is a constraint of
  the deployment.

## Functional requirements

The system shall …

| ID | Requirement | Realized by | Use case | Motivation |
|---|---|---|---|---|
| FR1 | run a search only for the exact title and citation context (case and spacing ignored) of one of the 1,975 held-out test events | Exact match on full title and context | UC2, UC3 | A ranking can only be checked for an event with an observed cited paper |
| FR2 | let the user select an event from one example per citation intent or from up to eight full-title suggestions shown after three typed characters | Example events; title suggestions | UC4 | Goal 3 |
| FR3 | restrict the events offered for selection to a chosen citation intent and scientific field | Intent and Field selectors | UC4 | The evaluation set is sampled per intent and each event has a field |
| FR4 | form the query of the selected event from its citing-paper title, citation context, and citation intent | Query card | UC2 | A citation event is defined by these three parts |
| FR5 | rank at request time the fixed 100 candidates of the selected event (the observed cited paper and 99 same-field papers) | Ranking service | UC2 | Candidate sets are fixed in the evaluation set |
| FR6 | rank under the condition selected among C1, C2, and C3, with C2 by default | Condition tabs | UC2 | C2 (title + context) is the condition that improves retrieval over the title alone |
| FR7 | display the rank of the observed cited paper under each of C1, C2, and C3 | Cited-paper card | UC2, UC3 | Shows the effect of context and intent for the event |
| FR8 | list the ten highest-ranked candidates with their bibliographic metadata, similarity score, and rank | Result list | UC2 | Shows what is ranked above or below the cited paper |
| FR9 | show for each listed candidate its citation counts per intent and up to four citing papers with their contexts, excluding the query's citing paper | Intent counts; *Show citation contexts* | UC1 | Goal 2 |
| FR10 | provide for each ranked event its IDCite citation-event identifier and a CSV file of all 100 candidates with their scores and ranks | Event identifier; CSV of all 100 candidates | UC3 | Goal 3 |
| FR11 | link the ranked papers to their paper detail pages and to the Citation Network view filtered by citation intent | Paper detail; Citation Network | UC1, UC5 | Goal 1 |
| FR12 | display a seed paper with its related entities and citation events as a graph, together with the ontology of the graph | Knowledge Graph view; subgraph endpoint | UC5 | Goal 1 |
| FR13 | execute SPARQL queries against the knowledge graph and show the results as a table exportable as CSV, with example queries and the ontology | SPARQL view; SPARQL proxy; QLever index | UC6 | Goal 1 |

## Non-functional requirements

| ID | Quality (ISO/IEC 25010) | Requirement |
|---|---|---|
| NFR1 | Reproducibility (functional suitability) | Displayed ranks must equal the reference per-query ranks. The service uses the same test events, candidate sets, frozen SciBERT encoder, candidate representation, fusion coefficient (β = 0.75), and cosine scoring as the reference run. |
| NFR2 | Verifiability (research use) | The evaluation set can be regenerated from the public IDCite files with a fixed random seed; the service reports the hash of the candidate matrix it has loaded, which can be compared with the published one. |
| NFR3 | Transparency (research use) | Only the observed cited paper is marked in the results; every candidate is shown with the citation contexts that record how it has been cited, and the example events are labelled as not representative. |
| NFR4 | Deployability (flexibility) | The service runs on a server without a GPU; seed-paper vectors (23,479 × 768) are computed once offline, and only the query is encoded at request time. |
| NFR5 | Data locality (constraint) | The IDCite Parquet tables are read in place on the server. |
| NFR6 | Availability (reliability) | The encoder and index are loaded in the background at start-up; if the evaluation set or index is missing, Citation search reports this and the other functions keep working. |
| NFR7 | Security (security) | The API is read-only, requires no user account, and is served over HTTPS. |
| NFR8 | Safe query access (security, reliability) | SPARQL access must not allow the knowledge graph to be modified or the engine to be overloaded: only SELECT, ASK, CONSTRUCT, and DESCRIBE queries of at most 8,000 characters are forwarded, each with a 60-second timeout, and the engine is reachable only from the service. |

## Verification

Every requirement is verified individually, by inspection (I) of the code or configuration,
demonstration (D) in the interface, or test (T) with given inputs. Each script writes its evidence
and a pass/fail result to JSON or CSV.

| ID | Method | Script |
|---|---|---|
| FR1–FR13 | T (FR4: D; FR2, FR11, FR12: D and T) | `verify_requirements.py` |
| NFR1 | T | `verify_service.py` (ranks of the cited paper for all 1,975 test events) |
| NFR2 | T | `verify_requirements.py` (matrix hash); `scripts/extract_candidates.py` (regeneration, see [evaluation-dataset.md](evaluation-dataset.md)) |
| NFR3 | I, T | `inspect_code.py`; `verify_requirements.py` |
| NFR4 | I, T | `inspect_code.py`; `verify_service.py` (all requests answered on a CPU-only server) |
| NFR5 | I | `verify_requirements.py` (data configuration reported by the service) |
| NFR6 | I, T | `inspect_code.py`; `verify_isolated_instance.py` (instance started without the evaluation set) |
| NFR7 | I | `inspect_code.py`; `verify_requirements.py` (HTTPS) |
| NFR8 | T | `verify_isolated_instance.py` (modifying and oversized SPARQL queries) |

`verify_isolated_instance.py` sends modifying SPARQL queries and therefore refuses to run against a
host other than localhost; use it on a separate local instance only.

## References

1. ISO/IEC/IEEE. **ISO/IEC/IEEE 29148:2018 Systems and Software Engineering — Life Cycle Processes — Requirements Engineering.** International Standard, 2018. https://www.iso.org/standard/72089.html

2. ISO/IEC. **ISO/IEC 25010:2023 Systems and Software Engineering — Systems and Software Quality Requirements and Evaluation (SQuaRE) — Product Quality Model.** International Standard, 2023. https://www.iso.org/standard/78176.html

3. Martin Glinz. **On Non-Functional Requirements.** In *Proceedings of the 15th IEEE International Requirements Engineering Conference (RE)*, 2007, pp. 21–26. https://doi.org/10.1109/RE.2007.45

4. Kasper Hornbæk, Per Ola Kristensson, and Antti Oulasvirta. **Introduction to Human-Computer Interaction.** Oxford University Press, 2025, Chapter 15. https://doi.org/10.1093/oso/9780192864543.001.0001

5. Alistair Cockburn. **Writing Effective Use Cases.** Addison-Wesley, 2001.
