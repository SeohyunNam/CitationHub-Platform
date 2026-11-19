import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import Layout from '../../components/Layout'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const INTENT_COLORS = {
  background:   '#94a3b8', uses:         '#22c55e',
  similarities: '#3b82f6', motivation:   '#f59e0b',
  differences:  '#ef4444', future_work:  '#8b5cf6',
  extends:      '#06b6d4',
}
const INTENT_BADGE = {
  background:   'bg-slate-100 text-slate-600',
  uses:         'bg-green-50 text-green-700',
  similarities: 'bg-blue-50 text-blue-700',
  motivation:   'bg-amber-50 text-amber-700',
  differences:  'bg-red-50 text-red-700',
  future_work:  'bg-purple-50 text-purple-700',
  extends:      'bg-cyan-50 text-cyan-700',
}

/**
 * Publisher page for a paper, as on the Search page: its DOI, else the DOI in its id
 * ("seed:<doi>", "citing:<doi>"), else its Semantic Scholar page ("citing_pid:<id>").
 */
function externalUrl(doi, id) {
  if (doi) return `https://doi.org/${doi}`
  if (id?.startsWith('seed:')) return `https://doi.org/${id.slice(5)}`
  if (id?.startsWith('citing:')) return `https://doi.org/${id.slice(7)}`
  if (id?.startsWith('citing_pid:')) return `https://www.semanticscholar.org/paper/${id.slice(11)}`
  return null
}

// Papers per page in the Citing Papers and Co-cited tabs.
const PAGE_SIZE = 20

/** Page numbers to show: first, last, and two on each side of the current page. */
function pageItems(page, totalPages) {
  const keep = new Set([1, totalPages])
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= totalPages) keep.add(p)
  const sorted = [...keep].sort((a, b) => a - b)
  const items = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) items.push('…')
    items.push(p)
  })
  return items
}

function Pager({ page, total, loading, onChange }) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (totalPages <= 1) return null
  const btn = 'min-w-[2rem] px-2 py-1 rounded text-xs tabular-nums'
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1 mt-4" aria-label="Pages">
      <button disabled={page <= 1 || loading} onClick={() => onChange(page - 1)}
        className={`${btn} text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent`}>‹ Prev</button>
      {pageItems(page, totalPages).map((p, i) => p === '…'
        ? <span key={`gap${i}`} className="px-1 text-xs text-gray-300">…</span>
        : <button key={p} disabled={loading} onClick={() => onChange(p)} aria-current={p === page ? 'page' : undefined}
            className={`${btn} ${p === page ? 'bg-brand-700 text-white font-semibold' : 'text-gray-600 hover:bg-gray-100'}`}>{p}</button>)}
      <button disabled={page >= totalPages || loading} onClick={() => onChange(page + 1)}
        className={`${btn} text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent`}>Next ›</button>
    </nav>
  )
}

/**
 * One tab's paged list. Page 1 comes with the page data; other pages are fetched from
 * /api/{kind}/{paper id}. Resets when another paper is shown.
 */
function usePagedList(kind, paperId, firstPage, total) {
  const initial = { page: 1, results: firstPage, total, loading: false }
  const [state, setState] = useState(initial)
  useEffect(() => { setState(initial) }, [paperId])
  const go = page => {
    if (page === 1) { setState(initial); return }
    setState(s => ({ ...s, loading: true }))
    fetch(`${API}/api/${kind}/${encodeURIComponent(paperId)}?page=${page}&limit=${PAGE_SIZE}`)
      .then(r => r.json())
      .then(d => setState({ page, results: d.results || [], total: d.total ?? total, loading: false }))
      .catch(() => setState(s => ({ ...s, loading: false })))
  }
  return [state, go]
}

export async function getServerSideProps({ params }) {
  try {
    const res  = await fetch(`${API}/api/papers/${encodeURIComponent(params.id)}?limit=${PAGE_SIZE}&cocited_limit=${PAGE_SIZE}`)
    if (!res.ok) return { notFound: true }
    const data = await res.json()
    return { props: { data } }
  } catch {
    return { notFound: true }
  }
}

export default function PaperDetailPage({ data }) {
  const { paper, total_events, intent_summary, citing_papers, cocited_papers } = data
  const citingTotal = data.unique_citing ?? citing_papers.length
  const cocitedTotal = data.cocited_total ?? cocited_papers.length
  const [activeTab, setActiveTab] = useState('overview')
  const [citing, goCiting] = usePagedList('citing', paper.seed_paper_id, citing_papers, citingTotal)
  const [cocited, goCocited] = usePagedList('cocited', paper.seed_paper_id, cocited_papers, cocitedTotal)

  const exportCitations = () => {
    window.open(`${API}/api/export/paper/${encodeURIComponent(paper.seed_paper_id)}`)
  }

  const tabs = [
    { id: 'overview',  label: 'Overview' },
    { id: 'citing',    label: `Citing Papers (${citingTotal.toLocaleString()})` },
    { id: 'cocited',   label: `Co-cited (${cocitedTotal.toLocaleString()})` },
  ]

  return (
    <Layout>
      <Head><title>{paper.title || 'Paper'} — CitationHub</title></Head>

      <div className="max-w-7xl mx-auto px-6 py-6">
        <Link href="/search" className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 mb-5">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd"/>
          </svg>
          Back to search
        </Link>

        {/* Paper header */}
        <div className="bg-white border border-gray-100 rounded-lg p-6 mb-5">
          <h1 className="text-lg font-bold text-gray-900 leading-snug mb-3">
            {paper.title || '(No title)'}
          </h1>

          <div className="flex flex-wrap gap-1.5 mb-4">
            {paper.field && <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">{paper.field}</span>}
            {paper.country && <span className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-700 font-medium">{paper.country}</span>}
            {paper.doi && (
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener noreferrer"
                className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 font-medium">
                DOI
              </a>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Cited by',        value: Number(paper.citedby_count).toLocaleString() },
              { label: 'Citation Events', value: total_events.toLocaleString() },
              { label: 'Published',       value: paper.cover_date?.slice(0, 7) || '—' },
              { label: 'Journal',         value: paper.journal || '—' },
            ].map(({ label, value }) => (
              <div key={label} className="bg-gray-50 rounded-md p-3">
                <div className="text-xs text-gray-400 mb-0.5">{label}</div>
                <div className="text-sm font-semibold text-gray-800 truncate">{value}</div>
              </div>
            ))}
          </div>

          <div className="grid sm:grid-cols-3 gap-x-6 gap-y-1 text-sm text-gray-600 mb-4">
            {[
              ['Author', paper.author], ['Affiliation', paper.affiliation],
              ['City', paper.city],
            ].map(([k, v]) => v ? (
              <div key={k} className="truncate">
                <span className="text-gray-400 text-xs font-medium mr-1">{k}</span>{v}
              </div>
            ) : null)}
          </div>

          <div className="flex flex-wrap gap-2">
            <Link href={{ pathname: '/kg', query: { paper_id: paper.seed_paper_id } }}
              className="text-xs border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700 px-3 py-1.5 rounded-md transition-colors font-medium">
              View Knowledge Graph
            </Link>
            <button onClick={exportCitations}
              className="text-xs border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700 px-3 py-1.5 rounded-md transition-colors font-medium">
              Export Citations CSV
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-5">
          <div className="flex gap-0 overflow-x-auto">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === t.id
                    ? 'border-brand-700 text-brand-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Overview */}
        {activeTab === 'overview' && (
          <div className="grid md:grid-cols-2 gap-5">
            <div className="bg-white border border-gray-100 rounded-lg p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Intent Distribution</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={intent_summary} margin={{ left: -20 }}>
                  <XAxis dataKey="intent" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {intent_summary.map(d => (
                      <Cell key={d.intent} fill={INTENT_COLORS[d.intent] || '#94a3b8'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white border border-gray-100 rounded-lg p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Paper Metadata</h3>
              <dl className="space-y-2">
                {[
                  ['Author',      paper.author],
                  ['Affiliation', paper.affiliation],
                  ['Journal',     paper.journal],
                  ['Field',       paper.field],
                  ['Country',     paper.country],
                  ['Published',   paper.cover_date],
                  ['DOI',         paper.doi],
                ].map(([k, v]) => v ? (
                  <div key={k} className="flex gap-3 text-sm">
                    <dt className="text-gray-400 w-24 shrink-0 text-xs pt-0.5">{k}</dt>
                    <dd className="text-gray-700 break-all text-xs">{v}</dd>
                  </div>
                ) : null)}
              </dl>
            </div>
          </div>
        )}

        {/* Citing papers */}
        {activeTab === 'citing' && (
          <p className="text-xs text-gray-400 mb-2">
            {citingTotal.toLocaleString()} citing papers, most citation contexts first
            {citingTotal > PAGE_SIZE && ` · ${PAGE_SIZE} per page`}.
          </p>
        )}
        {activeTab === 'citing' && (
          <div className={`bg-white border border-gray-100 rounded-lg overflow-hidden ${citing.loading ? 'opacity-50' : ''}`}>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {['Title', 'Year', 'Intent', 'Contexts'].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {citing.results.map((p, i) => (
                  <tr key={i} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 max-w-xs">
                      {externalUrl(p.citing_doi, p.citing_paper_id)
                        ? <a href={externalUrl(p.citing_doi, p.citing_paper_id)} target="_blank" rel="noopener noreferrer"
                            title={p.citing_doi ? `DOI ${p.citing_doi}` : 'Semantic Scholar'}
                            className="text-brand-700 hover:underline line-clamp-2 text-xs">
                            {p.citing_title || p.citing_doi || p.citing_paper_id}
                          </a>
                        : <span className="text-gray-700 line-clamp-2 text-xs">{p.citing_title || '—'}</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{p.citing_year || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${INTENT_BADGE[String(p.primary_intent).split(' ')[0]] || 'bg-gray-100 text-gray-500'}`}>
                        {p.primary_intent}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{p.context_count ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {activeTab === 'citing' && (
          <Pager page={citing.page} total={citing.total} loading={citing.loading} onChange={goCiting} />
        )}

        {/* Co-cited */}
        {activeTab === 'cocited' && (
          <div>
            <p className="text-xs text-gray-400 mb-4">
              {cocitedTotal.toLocaleString()} papers appear alongside this paper in the same citing works, most co-citations first
              {cocitedTotal > PAGE_SIZE && ` · ${PAGE_SIZE} per page`}.
            </p>
            {cocited.results.length === 0
              ? <div className="bg-white border border-gray-100 rounded-lg p-10 text-center text-sm text-gray-400">No co-cited papers found.</div>
              : (
                <div className={`space-y-2 ${cocited.loading ? 'opacity-50' : ''}`}>
                  {cocited.results.map((p, i) => (
                    <div key={i} className="bg-white border border-gray-100 rounded-lg px-5 py-3.5 flex items-center gap-4">
                      <span className="text-xl font-bold text-gray-100 w-8 shrink-0 tabular-nums">{(cocited.page - 1) * PAGE_SIZE + i + 1}</span>
                      <div className="flex-1 min-w-0">
                        {externalUrl(null, p.seed_paper_id)
                          ? <a href={externalUrl(null, p.seed_paper_id)} target="_blank" rel="noopener noreferrer"
                              className="text-sm font-medium text-brand-700 hover:underline line-clamp-1">
                              {p.title || p.seed_paper_id}
                            </a>
                          : <span className="text-sm font-medium text-gray-800 line-clamp-1">{p.title || p.seed_paper_id}</span>
                        }
                        <div className="text-xs text-gray-400 mt-0.5">
                          {p.field && <span className="mr-2">{p.field}</span>}
                          Cited by {Number(p.citedby_count || 0).toLocaleString()}
                          <Link href={`/papers/${encodeURIComponent(p.seed_paper_id)}`}
                            className="ml-3 text-brand-600 hover:underline">
                            View in CitationHub
                          </Link>
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-brand-600 shrink-0 tabular-nums">
                        {p.co_citation_count}
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
            <Pager page={cocited.page} total={cocited.total} loading={cocited.loading} onChange={goCocited} />
          </div>
        )}
      </div>
    </Layout>
  )
}
