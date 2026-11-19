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

const INTENT_COLORS = {
  background: '#94a3b8',
  uses: '#22c55e',
  similarities: '#3b82f6',
  motivation: '#f59e0b',
  differences: '#ef4444',
  future_work: '#8b5cf6',
  extends: '#06b6d4',
}

// Citing papers drawn at most; the CSV export always has every citation event.
const MAX_NODES = 500

const INTENT_LABELS = {
  background: 'Background',
  uses: 'Uses',
  similarities: 'Similarities',
  motivation: 'Motivation',
  differences: 'Differences',
  future_work: 'Future Work',
  extends: 'Extends',
}

export default function NetworkPage() {
  const router = useRouter()
  const { paper_id } = router.query
  const intentParam = typeof router.query.intents === 'string' ? router.query.intents : ''
  const [intentFilter, setIntentFilter] = useState([])

  const [papers, setPapers] = useState([])
  const [selected, setSelected] = useState('')
  const [paper, setPaper] = useState(null)
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState(null)

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
    setIntentFilter(intentParam.split(',').filter(i => INTENT_LABELS[i]))
  }, [intentParam])

  const toggleIntent = (intent) => {
    const next = intentFilter.includes(intent)
      ? intentFilter.filter(i => i !== intent)
      : [...intentFilter, intent]
    const query = { ...router.query, paper_id: selected }
    if (next.length) query.intents = next.join(','); else delete query.intents
    router.replace({ pathname: '/network', query }, undefined, { shallow: true })
  }

  useEffect(() => {
    if (!selected) return
    setLoading(true); setPaper(null); setInfo(null)
    const p = new URLSearchParams({ limit: String(MAX_NODES) })
    if (intentFilter.length) p.set('intents', intentFilter.join(','))
    fetch(`${API}/api/papers/${encodeURIComponent(selected)}?${p}`)
      .then(r => r.json())
      .then(d => { setPaper(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [selected, intentFilter.join(',')])

  const { netNodes, netEdges } = useMemo(() => {
    if (!paper?.paper || !paper?.citing_papers) return { netNodes: [], netEdges: [] }

    const seed = paper.paper
    const seedId = seed.seed_paper_id || selected

    const nodes = [{
      id: seedId,
      label: (seed.title || seedId).slice(0, 28),
      color: '#111827',
      size: 22,
      isSeed: true,
    }]
    const edges = []
    const seen = new Set([seedId])

    paper.citing_papers.forEach((p, i) => {
      const cid = p.citing_paper_id || `_cite_${i}`
      if (seen.has(cid)) return
      seen.add(cid)
      // a two-label event ("background similarities") takes its first label's color
      const intent = (p.primary_intent || 'background').split(' ')[0]
      const sz = Math.max(6, Math.min(18, 6 + (p.context_count || 0) * 1.0))

      nodes.push({
        id: cid,
        label: (p.citing_title || cid).slice(0, 25),
        color: INTENT_COLORS[intent] || '#94a3b8',
        size: sz,
        intent,
        title: p.citing_title,
        year: p.citing_year,
      })
      edges.push({ source: cid, target: seedId, color: INTENT_COLORS[intent] || '#e2e8f0' })
    })

    return { netNodes: nodes, netEdges: edges }
  }, [paper, selected])

  const hasData = netNodes.length > 1

  return (
    <Layout>
      <Head><title>Citation Network | CitationHub</title></Head>

      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-gray-900 mb-1">Citation Network</h1>
          <p className="text-sm text-gray-400">
            Which papers cite a seed paper, and with what intent? Nodes colored by citation intent.
          </p>
        </div>

        {/* Paper selector */}
        <div className="bg-white border border-gray-100 rounded-lg p-4 mb-4 flex flex-wrap gap-3 items-center">
          <label className="text-xs font-medium text-gray-500 shrink-0">Seed Paper</label>
          <select value={selected} onChange={e => setSelected(e.target.value)}
            className="flex-1 min-w-0 max-w-xl text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white text-gray-700">
            {selected && !papers.some(p => p.seed_paper_id === selected) && (
              <option value={selected}>{(paper?.paper?.title || selected).slice(0, 80)}</option>
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
              View Detail
            </Link>
          )}
          {selected && (
            <a href={`${API}/api/export/paper/${encodeURIComponent(selected)}${intentFilter.length ? `?intents=${intentFilter.join(',')}` : ''}`}
              className="text-xs border border-gray-200 hover:border-gray-300 text-gray-600 px-3 py-2 rounded-md hover:bg-gray-50 transition-colors font-medium shrink-0"
              title="Every IDCite citation event shown here, with its citation_event_id and citation contexts">
              Download citation events (CSV)
            </a>
          )}
        </div>

        {/* Intent legend */}
        <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Citation Intent <span className="normal-case font-normal text-gray-300">· click to filter</span>
            {paper && (
              <span className="ml-2 font-normal text-gray-300 normal-case">
                {(paper.citing_papers?.length || 0) < (paper.unique_citing ?? 0)
                  ? `${paper.citing_papers.length.toLocaleString()} of ${paper.unique_citing.toLocaleString()} citing papers shown (most citation contexts first)`
                  : `${(paper.unique_citing ?? paper.citing_papers?.length ?? 0).toLocaleString()} citing papers`}
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-gray-900" />
              <span className="text-xs text-gray-700 font-medium">Seed Paper</span>
            </div>
            {Object.entries(INTENT_LABELS).map(([intent, label]) => {
              const active = !intentFilter.length || intentFilter.includes(intent)
              return (
                <button key={intent} type="button" onClick={() => toggleIntent(intent)}
                  title="Show only citations with this intent"
                  className={`flex items-center gap-1.5 ${active ? '' : 'opacity-35'} ${intentFilter.includes(intent) ? 'font-semibold' : ''}`}>
                  <span className="w-3 h-3 rounded-full" style={{ background: INTENT_COLORS[intent] }} />
                  <span className="text-xs text-gray-600">{label}</span>
                </button>
              )
            })}
            {intentFilter.length > 0 && (
              <button type="button" onClick={() => { const q = { ...router.query }; delete q.intents; router.replace({ pathname: '/network', query: q }, undefined, { shallow: true }) }}
                className="text-xs text-brand-700 hover:underline">Show all intents</button>
            )}
          </div>
        </div>

        {/* Graph */}
        <div className="flex gap-4 mb-2">
          <div className="flex-1 bg-white border border-gray-100 rounded-lg overflow-hidden relative" style={{ height: 580 }}>
            {loading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 gap-3">
                <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-gray-400">Building network...</span>
              </div>
            )}
            {!loading && paper && !hasData && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
                No citation data for this paper.
              </div>
            )}
            {!loading && hasData && (
              <ForceGraph
                key={selected}
                nodes={netNodes}
                edges={netEdges}
                height={580}
                onNodeClick={n => setInfo(n)}
              />
            )}
          </div>

          {info && (
            <div className="w-52 shrink-0">
              <div className="bg-white border border-gray-100 rounded-lg p-4 sticky top-20">
                {info.isSeed ? (
                  <>
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide block mb-2">Seed Paper</span>
                    <p className="text-sm text-gray-800 font-medium break-words leading-snug">{paper?.paper?.title || info.id}</p>
                    <p className="text-xs text-gray-400 mt-1">{paper?.paper?.journal || ''}</p>
                    <p className="text-xs text-gray-400">{paper?.paper?.cover_date?.slice(0, 4) || ''}</p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: INTENT_COLORS[info.intent] }} />
                      <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: INTENT_COLORS[info.intent] }}>
                        {INTENT_LABELS[info.intent] || info.intent}
                      </span>
                    </div>
                    <p className="text-sm text-gray-800 font-medium break-words leading-snug">{info.title || info.label}</p>
                    {info.year && <p className="text-xs text-gray-400 mt-1">{info.year}</p>}
                  </>
                )}
                <button onClick={() => setInfo(null)} className="mt-3 text-xs text-gray-300 hover:text-gray-500">Dismiss</button>
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-300 mt-1 text-center mb-8">
          Drag to pan · Scroll to zoom · Click node for details
        </p>

        {/* Stats */}
        {paper && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white border border-gray-100 rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-gray-900 tabular-nums">{(paper.total_events || 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400 mt-1">Total Citation Events</div>
            </div>
            <div className="bg-white border border-gray-100 rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-gray-900 tabular-nums">{(paper.unique_citing ?? paper.citing_papers?.length ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400 mt-1">Unique Citing Papers</div>
            </div>
            {(paper.intent_summary || []).filter(s => s.count > 0).slice(0, 2).map(s => (
              <div key={s.intent} className="bg-white border border-gray-100 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold tabular-nums" style={{ color: INTENT_COLORS[s.intent] || '#94a3b8' }}>
                  {(s.count || 0).toLocaleString()}
                </div>
                <div className="text-xs text-gray-400 mt-1 capitalize">{s.intent?.replace('_', ' ')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  )
}
