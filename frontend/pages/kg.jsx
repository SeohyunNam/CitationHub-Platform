import { useState, useEffect, useMemo } from 'react'
import dynamic from 'next/dynamic'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import Layout from '../components/Layout'

const ForceGraph = dynamic(() => import('../components/ForceGraph'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      <span className="text-xs text-gray-400">Loading graph...</span>
    </div>
  ),
})

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const NODE_TYPE_COLORS = {
  seed_paper:     '#111827',
  citing_paper:   '#3b82f6',
  citation_event: '#f59e0b',
  journal:        '#8b5cf6',
  author:         '#ef4444',
  affiliation:    '#ec4899',
  city:           '#06b6d4',
  country:        '#f97316',
  field:          '#6366f1',
  intent:         '#22c55e',
}

const NODE_DESCRIPTIONS = {
  seed_paper:     'Highly cited seed paper (top 5% cited)',
  citing_paper:   'Paper that cites a seed paper',
  citation_event: 'One citing paper citing one seed paper, with all its citation contexts and intent label(s)',
  journal:        'Publication venue of seed paper',
  author:         'Author of seed paper',
  affiliation:    'Institutional affiliation',
  city:           'City of affiliation',
  country:        'Country of affiliation',
  field:          'Research field / discipline',
  intent:         'Citation intent label',
}

const ONTOLOGY_NODES_DEF = [
  { id: 'seed',        label: 'SeedPaper',     type: 'seed_paper',     color: '#111827', size: 30, props: 'doi · title · journal · author · affiliation · country · field · citedby_count' },
  { id: 'event',       label: 'CitationEvent', type: 'citation_event', color: '#f59e0b', size: 18, props: 'event_id · citing paper → seed paper · contexts (one or more sentences) · primary_intent (one or two labels) · citing_year · is_influential' },
  { id: 'citing',      label: 'CitingPaper',   type: 'citing_paper',   color: '#3b82f6', size: 18, props: 'doi · title · year · venue' },
  { id: 'intent',      label: 'Intent',        type: 'intent',         color: '#22c55e', size: 14, props: 'background · uses · similarities · motivation · differences · future_work · extends' },
  { id: 'journal',     label: 'Journal',       type: 'journal',        color: '#8b5cf6', size: 14, props: 'journal_name' },
  { id: 'author',      label: 'Author',        type: 'author',         color: '#ef4444', size: 14, props: 'author_name · author_id' },
  { id: 'affiliation', label: 'Affiliation',   type: 'affiliation',    color: '#ec4899', size: 14, props: 'affiliation_name' },
  { id: 'city',        label: 'City',          type: 'city',           color: '#06b6d4', size: 12, props: 'city_name' },
  { id: 'country',     label: 'Country',       type: 'country',        color: '#f97316', size: 12, props: 'country_name' },
  { id: 'field',       label: 'Field',         type: 'field',          color: '#6366f1', size: 12, props: 'field_name' },
]

const ONTOLOGY_EDGES_DEF = [
  { from: 'event',  to: 'citing',      label: 'hasCitingPaper' },
  { from: 'event',  to: 'seed',        label: 'hasCitedPaper' },
  { from: 'event',  to: 'intent',      label: 'hasPrimaryIntent' },
  { from: 'seed',   to: 'journal',     label: 'publishedInJournal' },
  { from: 'seed',   to: 'author',      label: 'hasAuthor' },
  { from: 'seed',   to: 'affiliation', label: 'hasAffiliation' },
  { from: 'seed',   to: 'city',        label: 'locatedInCity' },
  { from: 'seed',   to: 'country',     label: 'locatedInCountry' },
  { from: 'seed',   to: 'field',       label: 'belongsToField' },
]

export default function KGPage() {
  const router = useRouter()
  const { paper_id } = router.query

  const [papers,   setPapers]   = useState([])
  const [selected, setSelected] = useState('')
  const [kgData,   setKgData]   = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [info,     setInfo]     = useState(null)
  const [tab,      setTab]      = useState('explorer')

  useEffect(() => {
    fetch(`${API}/api/search?limit=100`)
      .then(r => r.json())
      .then(d => {
        const results = d.results || []
        setPapers(results)
        // keep a paper already chosen from the URL (?paper_id=) — the router can
        // resolve it before this list arrives
        setSelected(prev => prev || results[0]?.seed_paper_id || '')
      })
  }, [])

  useEffect(() => {
    if (paper_id && paper_id !== selected) setSelected(paper_id)
  }, [paper_id])

  useEffect(() => {
    if (!selected) return
    setLoading(true); setKgData(null); setInfo(null)
    fetch(`${API}/api/kg/${encodeURIComponent(selected)}`)
      .then(r => r.json())
      .then(d => { setKgData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [selected])

  // Full title of a paper opened from a link that is not in the 100-paper list
  // (graph labels are shortened, so look it up by DOI).
  const [selectedTitle, setSelectedTitle] = useState('')
  useEffect(() => {
    setSelectedTitle('')
    if (!selected || papers.some(p => p.seed_paper_id === selected)) return
    const doi = selected.replace(/^seed:/, '')
    fetch(`${API}/api/search?q=${encodeURIComponent(doi)}&limit=5`)
      .then(r => r.json())
      .then(d => setSelectedTitle((d.results || []).find(p => p.seed_paper_id === selected)?.title || ''))
      .catch(() => {})
  }, [selected, papers])

  // Map backend nodes/edges to ForceGraph format
  const { kgNodes, kgEdges } = useMemo(() => {
    if (!kgData?.nodes?.length) return { kgNodes: [], kgEdges: [] }
    return {
      kgNodes: kgData.nodes.map(n => ({
        id:    n.id,
        label: n.label,
        color: n.color || NODE_TYPE_COLORS[n.type] || '#94a3b8',
        size:  n.size || 16,
        type:  n.type,
      })),
      kgEdges: kgData.edges.map((e, i) => ({
        source: e.source,
        target: e.target,
        label:  e.label || e.edge_type || '',
      })),
    }
  }, [kgData])

  const ontologyNodes = useMemo(() => ONTOLOGY_NODES_DEF.map(n => ({
    id: n.id, label: n.label, color: n.color, size: n.size, type: n.type,
  })), [])

  const ontologyEdges = useMemo(() => ONTOLOGY_EDGES_DEF.map(e => ({
    source: e.from, target: e.to, label: e.label,
  })), [])

  const hasKgData = kgNodes.length > 0

  return (
    <Layout>
      <Head><title>Knowledge Graph | CitationHub</title></Head>

      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-gray-900 mb-1">Knowledge Graph</h1>
          <p className="text-sm text-gray-400">Heterogeneous scholarly knowledge graph linking papers, authors, affiliations, fields, and citation intents.</p>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-4">
          <div className="flex gap-0">
            {[
              { id: 'explorer', label: 'Knowledge Graph' },
              { id: 'ontology', label: 'Citation Event Schema' },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === t.id ? 'border-brand-700 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Explorer */}
        {tab === 'explorer' && (
          <>
            {/* Paper selector */}
            <div className="bg-white border border-gray-100 rounded-lg p-4 mb-4 flex flex-wrap gap-3 items-center">
              <label className="text-xs font-medium text-gray-500 shrink-0">Paper</label>
              <select value={selected} onChange={e => setSelected(e.target.value)}
                className="flex-1 min-w-0 max-w-xl text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white text-gray-700">
                {selected && !papers.some(p => p.seed_paper_id === selected) && (
                  <option value={selected}>{selectedTitle || selected}</option>
                )}
                {papers.map(p => (
                  <option key={p.seed_paper_id} value={p.seed_paper_id}>
                    {p.title?.slice(0, 80) || p.seed_paper_id}
                  </option>
                ))}
              </select>
              {selected && (
                <Link href={`/papers/${encodeURIComponent(selected)}`}
                  className="text-xs border border-gray-200 hover:border-gray-300 text-gray-600 px-3 py-2 rounded-md hover:bg-gray-50 transition-colors font-medium shrink-0">
                  View Paper Detail
                </Link>
              )}
            </div>

            {/* Legend */}
            <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 mb-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Node Types</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-y-2 gap-x-3">
                {Object.entries(NODE_TYPE_COLORS).map(([type, color]) => (
                  <div key={type} className="flex items-start gap-2">
                    <span className="w-3 h-3 rounded-full shrink-0 mt-0.5" style={{ background: color }} />
                    <div>
                      <div className="text-xs font-medium text-gray-700">{type.replace(/_/g, ' ')}</div>
                      <div className="text-xs text-gray-400 leading-tight">{NODE_DESCRIPTIONS[type]}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Graph */}
            <div className="flex gap-4 mb-2">
              <div className="flex-1 bg-white border border-gray-100 rounded-lg overflow-hidden relative" style={{ height: 560 }}>
                {loading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 gap-3">
                    <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-gray-400">Fetching graph data...</span>
                  </div>
                )}
                {!loading && !hasKgData && kgData !== null && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
                    No knowledge graph data for this paper.
                  </div>
                )}
                {!loading && hasKgData && (
                  <ForceGraph
                    key={selected}
                    nodes={kgNodes}
                    edges={kgEdges}
                    height={560}
                    onNodeClick={n => setInfo(n)}
                  />
                )}
              </div>

              {info && (
                <div className="w-52 shrink-0">
                  <div className="bg-white border border-gray-100 rounded-lg p-4 sticky top-20">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: info.color }} />
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        {info.type?.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-sm text-gray-800 font-medium break-words leading-snug mb-1">{info.label}</p>
                    <p className="text-xs text-gray-300 break-all">ID: {info.id}</p>
                    <p className="text-xs text-gray-400 mt-2">{NODE_DESCRIPTIONS[info.type] || ''}</p>
                    <button onClick={() => setInfo(null)} className="mt-3 text-xs text-gray-300 hover:text-gray-500">Dismiss</button>
                  </div>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-300 mb-8 text-center">
              Drag to pan · Scroll to zoom · Click node for details
              {hasKgData && <span className="ml-2">&middot; {kgNodes.length} nodes, {kgEdges.length} edges</span>}
            </p>
          </>
        )}

        {/* Ontology schema */}
        {tab === 'ontology' && (
          <div className="space-y-5">
            <div className="bg-white border border-gray-100 rounded-lg p-5">
              <p className="text-xs text-gray-400 mb-4">
                Each <b>CitationEvent</b> connects a <b>CitingPaper</b> to a <b>SeedPaper</b> with a citation intent label.
                Seed papers are linked to journals, authors, affiliations, cities, countries, and research fields.
              </p>
              <ForceGraph
                key="ontology"
                nodes={ontologyNodes}
                edges={ontologyEdges}
                height={480}
              />
            </div>

            <div className="grid md:grid-cols-2 gap-5">
              <div className="bg-white border border-gray-100 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Edge Types</h3>
                <div className="space-y-1.5">
                  {ONTOLOGY_EDGES_DEF.map((e, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-gray-600 bg-gray-50 rounded px-3 py-2">
                      <span className="font-medium text-gray-800">{e.from}</span>
                      <span className="text-gray-300">&rarr;</span>
                      <span className="font-medium text-gray-800">{e.to}</span>
                      <span className="ml-auto text-gray-400 italic">{e.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white border border-gray-100 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Node Types & Attributes</h3>
                <div className="divide-y divide-gray-50">
                  {ONTOLOGY_NODES_DEF.map(n => (
                    <div key={n.id} className="flex items-start gap-3 py-2.5">
                      <span className="w-3 h-3 rounded-full shrink-0 mt-0.5" style={{ background: n.color }} />
                      <div>
                        <span className="text-sm font-medium text-gray-800">{n.label}</span>
                        <div className="text-xs text-gray-400 mt-0.5">{n.props}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
