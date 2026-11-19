import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import Layout from '../../components/Layout'
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const INTENT_COLORS = {
  background:   '#94a3b8',
  uses:         '#22c55e',
  similarities: '#3b82f6',
  motivation:   '#f59e0b',
  differences:  '#ef4444',
  future_work:  '#8b5cf6',
  extends:      '#06b6d4',
}

function Stat({ label, value }) {
  return (
    <div className="bg-white rounded-lg border border-gray-100 px-5 py-4">
      <div className="text-2xl font-bold text-brand-700 tabular-nums">{value}</div>
      <div className="text-xs text-gray-500 mt-1 font-medium">{label}</div>
    </div>
  )
}

export default function AuthorDetailPage() {
  const router = useRouter()
  const { id } = router.query

  const [detail,    setDetail]    = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [notFound,  setNotFound]  = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setNotFound(false)
    const eid = encodeURIComponent(id)
    Promise.all([
      fetch(`${API}/api/authors/${eid}`).then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetch(`${API}/api/authors/${eid}/analytics`).then(r => r.ok ? r.json() : null),
    ])
      .then(([d, a]) => { setDetail(d); setAnalytics(a); setLoading(false) })
      .catch(() => { setNotFound(true); setLoading(false) })
  }, [id])

  if (loading) return (
    <Layout>
      <div className="flex justify-center items-center h-80">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </Layout>
  )

  if (notFound || !detail) return (
    <Layout>
      <div className="text-center py-20 text-sm text-gray-400">Author not found.</div>
    </Layout>
  )

  const a = detail.author
  const intentData = (analytics?.intent_distribution || [])
    .map(d => ({ ...d, count: Number(d.count) }))
  const timeData = (analytics?.citations_over_time || [])
    .map(d => ({ year: d.year, count: Number(d.count) }))
  const venueData = (analytics?.top_venues || [])
    .map(d => ({ ...d, count: Number(d.count) }))

  return (
    <Layout>
      <Head><title>{a.name} | CitationHub</title></Head>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <Link href="/authors" className="text-xs text-gray-400 hover:text-gray-600">&larr; Back to author search</Link>

        {/* Header */}
        <h1 className="text-2xl font-bold text-gray-900 mt-3 mb-1">{a.name}</h1>
        <p className="text-sm text-gray-500 mb-1">
          {(a.affiliations || []).slice(0, 2).join(' · ') || '\u2014'}
        </p>
        <div className="flex flex-wrap gap-1.5 mb-6">
          {(a.fields || []).map(f => (
            <span key={f} className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">{f}</span>
          ))}
          {(a.countries || []).map(c => (
            <span key={c} className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-600 font-medium">{c}</span>
          ))}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          <Stat label="Seed Papers" value={Number(a.paper_count).toLocaleString()} />
          <Stat label="Total Citations" value={Number(a.total_citedby).toLocaleString()} />
          <Stat label="Citation Events" value={Number(analytics?.total_events || 0).toLocaleString()} />
        </div>

        {/* Citation pattern charts */}
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div className="bg-white border border-gray-100 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Citation Intent Distribution</h3>
            <p className="text-xs text-gray-400 mb-3">Why this author&apos;s papers are cited</p>
            {intentData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={intentData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <XAxis dataKey="intent" tick={{ fontSize: 10 }} tickFormatter={v => v.replace('_', ' ')} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip formatter={v => v.toLocaleString()} contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {intentData.map((entry, i) => (
                      <Cell key={i} fill={INTENT_COLORS[entry.intent] || '#94a3b8'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-xs text-gray-400 py-16 text-center">No citation data.</p>}
          </div>

          <div className="bg-white border border-gray-100 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Citations Over Time</h3>
            <p className="text-xs text-gray-400 mb-3">When this author&apos;s papers get cited</p>
            {timeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={timeData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip formatter={v => v.toLocaleString()} contentStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="count" stroke="#3b1d6e" fill="#ede9fe" strokeWidth={1.8} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <p className="text-xs text-gray-400 py-16 text-center">No citation data.</p>}
          </div>
        </div>

        {/* Top venues */}
        {venueData.length > 0 && (
          <div className="bg-white border border-gray-100 rounded-lg p-5 mb-8">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Top Venues Citing This Author</h3>
            <ResponsiveContainer width="100%" height={Math.max(160, venueData.length * 22)}>
              <BarChart data={venueData} layout="vertical" margin={{ left: 10 }}>
                <XAxis type="number" tick={{ fontSize: 9 }} />
                <YAxis dataKey="venue" type="category" tick={{ fontSize: 9 }} width={190}
                  tickFormatter={v => v?.slice(0, 40) || ''} />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="count" fill="#3b82f6" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Papers */}
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Papers ({detail.papers.length})</h2>
        <div className="space-y-2">
          {detail.papers.map(p => (
            <Link key={p.seed_paper_id} href={`/papers/${encodeURIComponent(p.seed_paper_id)}`}
              className="block bg-white border border-gray-100 rounded-lg px-5 py-4 hover:border-brand-200 hover:shadow-sm transition-all">
              <h3 className="text-sm font-semibold text-gray-800 leading-snug mb-1.5 line-clamp-2">{p.title || '(No title)'}</h3>
              <p className="text-xs text-gray-500 mb-2 line-clamp-1">
                {[p.journal, p.year].filter(Boolean).join(' · ')}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {p.field && <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">{p.field}</span>}
                {p.country && <span className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-600 font-medium">{p.country}</span>}
                <span className="text-xs px-2 py-0.5 rounded bg-gray-50 text-gray-500 font-medium ml-auto">
                  Cited by {Number(p.citedby_count).toLocaleString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </Layout>
  )
}
