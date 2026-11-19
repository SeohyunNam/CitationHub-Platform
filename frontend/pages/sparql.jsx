import { useState } from 'react'
import Head from 'next/head'
import Layout from '../components/Layout'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const PREFIXES = `PREFIX ch: <http://citationhub.org/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>`

const EXAMPLES = [
  {
    name: 'Most-cited seed papers',
    desc: 'Top 10 seed papers ranked by citation count.',
    query: `${PREFIXES}
SELECT ?title ?citedby WHERE {
  ?p a ch:SeedPaper ;
     rdfs:label ?title ;
     ch:citedbyCount ?citedby .
}
ORDER BY DESC(?citedby)
LIMIT 10`,
  },
  {
    name: 'Citation intent distribution',
    desc: 'How many citation events fall under each primary intent.',
    query: `${PREFIXES}
SELECT ?intent (COUNT(?ev) AS ?events) WHERE {
  ?ev a ch:CitationEvent ;
      ch:primaryIntent ?intent .
}
GROUP BY ?intent
ORDER BY DESC(?events)`,
  },
  {
    name: 'Top research fields',
    desc: 'Research fields with the most seed papers.',
    query: `${PREFIXES}
SELECT ?field (COUNT(?p) AS ?papers) WHERE {
  ?p a ch:SeedPaper ;
     ch:belongsToField ?f .
  ?f rdfs:label ?field .
}
GROUP BY ?field
ORDER BY DESC(?papers)
LIMIT 15`,
  },
  {
    name: 'Top authors by citations',
    desc: 'Authors whose seed papers accumulated the most citations.',
    query: `${PREFIXES}
SELECT ?author (SUM(?c) AS ?totalCitations) (COUNT(?p) AS ?papers) WHERE {
  ?p a ch:SeedPaper ;
     ch:hasAuthor ?a ;
     ch:citedbyCount ?c .
  ?a rdfs:label ?author .
}
GROUP BY ?author
ORDER BY DESC(?totalCitations)
LIMIT 10`,
  },
  {
    name: 'Top countries',
    desc: 'Countries with the most seed papers (via affiliations).',
    query: `${PREFIXES}
SELECT ?country (COUNT(?p) AS ?papers) WHERE {
  ?p a ch:SeedPaper ;
     ch:hasAffiliation ?aff .
  ?aff ch:locatedInCountry ?co .
  ?co rdfs:label ?country .
}
GROUP BY ?country
ORDER BY DESC(?papers)
LIMIT 15`,
  },
  {
    name: 'Total triples',
    desc: 'Count every triple in the knowledge graph.',
    query: `SELECT (COUNT(*) AS ?triples) WHERE { ?s ?p ?o }`,
  },
]

function cellValue(binding, varName) {
  const v = binding[varName]
  if (!v) return ''
  return v.value
}

function resultsToCsv(vars, bindings) {
  const esc = (s) => {
    const str = String(s ?? '')
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
  }
  const header = vars.map(esc).join(',')
  const rows = bindings.map((b) => vars.map((v) => esc(cellValue(b, v))).join(','))
  return [header, ...rows].join('\n')
}

export default function SparqlPage() {
  const [query, setQuery]     = useState(EXAMPLES[0].query)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(null)

  const run = async () => {
    setLoading(true)
    setError('')
    setResult(null)
    setElapsed(null)
    const t0 = performance.now()
    try {
      const res = await fetch(`${API}/api/sparql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const text = await res.text()
      if (!res.ok) {
        let detail = text
        try { detail = JSON.parse(text).detail || text } catch (_) {}
        setError(typeof detail === 'string' ? detail : JSON.stringify(detail))
      } else {
        setResult(JSON.parse(text))
        setElapsed(Math.round(performance.now() - t0))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const downloadCsv = () => {
    if (!result?.results?.bindings) return
    const vars = result.head.vars
    const csv = resultsToCsv(vars, result.results.bindings)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'sparql_results.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const vars     = result?.head?.vars || []
  const bindings = result?.results?.bindings || []
  const isAsk    = result && typeof result.boolean === 'boolean'

  return (
    <Layout>
      <Head><title>SPARQL - CitationHub</title></Head>
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900">SPARQL Explorer</h1>
        <p className="mt-1 text-sm text-gray-500 max-w-3xl">
          Query the CitationHub knowledge graph directly with SPARQL. The graph contains
          25.1M triples. Only read queries
          (SELECT / ASK / CONSTRUCT / DESCRIBE) are permitted.
        </p>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* sidebar: examples + ontology */}
          <aside className="lg:col-span-1 space-y-6">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Example queries
              </h2>
              <div className="space-y-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.name}
                    onClick={() => setQuery(ex.query)}
                    className="w-full text-left px-3 py-2 rounded-md border border-gray-200 bg-white hover:border-brand-400 hover:bg-brand-50 transition-colors"
                  >
                    <div className="text-sm font-medium text-gray-800">{ex.name}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{ex.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Ontology
              </h2>
              <div className="text-xs text-gray-500 space-y-2 bg-white border border-gray-200 rounded-md p-3">
                <div>
                  <span className="font-semibold text-gray-700">Classes</span>
                  <div className="font-mono mt-1 leading-relaxed">
                    ch:SeedPaper, ch:CitingPaper, ch:CitationEvent, ch:Author,
                    ch:Journal, ch:Affiliation, ch:City, ch:Country, ch:Field, ch:Intent
                  </div>
                </div>
                <div>
                  <span className="font-semibold text-gray-700">Relations</span>
                  <div className="font-mono mt-1 leading-relaxed">
                    hasAuthor, hasAffiliation, belongsToField, publishedIn,
                    locatedInCity, locatedInCountry, hasCitedPaper, hasCitingPaper,
                    hasPrimaryIntent, publishedInVenue
                  </div>
                </div>
                <div>
                  <span className="font-semibold text-gray-700">Data properties</span>
                  <div className="font-mono mt-1 leading-relaxed">
                    rdfs:label, ch:doi, ch:year, ch:citedbyCount, ch:primaryIntent,
                    ch:isInfluential, ch:venue, ch:publicationName
                  </div>
                </div>
              </div>
            </div>
          </aside>

          {/* main: editor + results */}
          <section className="lg:col-span-3 space-y-4">
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                rows={14}
                className="w-full px-4 py-3 font-mono text-sm text-gray-800 outline-none resize-y"
                placeholder="Enter a SPARQL query..."
              />
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-100 bg-gray-50">
                <div className="text-xs text-gray-400">
                  {elapsed != null && `${bindings.length} rows in ${elapsed} ms`}
                </div>
                <div className="flex items-center gap-2">
                  {result && bindings.length > 0 && (
                    <button
                      onClick={downloadCsv}
                      className="px-3 py-1.5 text-sm font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-100"
                    >
                      Download CSV
                    </button>
                  )}
                  <button
                    onClick={run}
                    disabled={loading}
                    className="px-5 py-1.5 text-sm font-semibold text-white bg-brand-700 rounded-md hover:bg-brand-800 disabled:opacity-50"
                  >
                    {loading ? 'Running...' : 'Run query'}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="text-sm font-semibold text-red-700">Query error</div>
                <pre className="mt-1 text-xs text-red-600 whitespace-pre-wrap font-mono">{error}</pre>
              </div>
            )}

            {isAsk && (
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <div className="text-sm text-gray-500">Result</div>
                <div className="text-2xl font-bold text-gray-900 mt-1">
                  {result.boolean ? 'true' : 'false'}
                </div>
              </div>
            )}

            {result && !isAsk && (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                {bindings.length === 0 ? (
                  <div className="text-center py-12 text-sm text-gray-400">No results.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-200">
                          {vars.map((v) => (
                            <th key={v} className="text-left px-4 py-2.5 font-semibold text-gray-600 whitespace-nowrap">
                              {v}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bindings.map((b, i) => (
                          <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                            {vars.map((v) => (
                              <td key={v} className="px-4 py-2 text-gray-700 align-top">
                                {cellValue(b, v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </Layout>
  )
}
