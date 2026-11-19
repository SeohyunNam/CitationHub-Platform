import { useEffect, useState } from 'react'
import Head from 'next/head'
import Layout from '../components/Layout'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend,
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

export default function AnalyticsPage() {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API}/api/analytics`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return (
    <Layout>
      <div className="flex justify-center items-center h-80">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </Layout>
  )

  if (!data) return (
    <Layout>
      <div className="text-center py-20 text-sm text-gray-400">Failed to load analytics data.</div>
    </Layout>
  )

  const trendByYear = {}
  data.intent_trend.forEach(({ year, primary_intent, count }) => {
    if (!year) return
    if (!trendByYear[year]) trendByYear[year] = { year }
    trendByYear[year][primary_intent] = count
  })
  const trendData = Object.values(trendByYear).sort((a, b) => a.year - b.year)

  const influentialTotal = data.influential.reduce((s, d) => s + Number(d.count), 0)
  const influentialYes   = Number(data.influential.find(d => d.is_influential === true)?.count || 0)
  const influentialPct   = influentialTotal ? ((influentialYes / influentialTotal) * 100).toFixed(1) : 0

  const intentBarData = [...(data.global_intent || [])].sort((a, b) => b.count - a.count)

  return (
    <Layout>
      <Head><title>Analytics | CitationHub</title></Head>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-xl font-bold text-gray-900 mb-1">Citation Analytics</h1>
        <p className="text-sm text-gray-400 mb-8">Global statistics across all citation events in CitationHub.</p>

        {/* Row 1: Intent Distribution (bar) + Influential */}
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div className="bg-white border border-gray-100 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Citation Intent Distribution</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={intentBarData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <XAxis dataKey="intent" tick={{ fontSize: 10 }} tickFormatter={v => v.replace('_', ' ')} />
                <YAxis tick={{ fontSize: 9 }} />
                <Tooltip formatter={v => v.toLocaleString()} contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {intentBarData.map((entry, i) => (
                    <Cell key={i} fill={INTENT_COLORS[entry.intent] || '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white border border-gray-100 rounded-lg p-5 flex flex-col justify-between">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Influential Citations</h3>
            <div className="text-center py-6">
              <div className="text-5xl font-bold text-brand-700 tabular-nums">{influentialPct}%</div>
              <div className="text-sm text-gray-400 mt-2">of citations are influential</div>
              <div className="text-xs text-gray-300 mt-1">
                {influentialYes.toLocaleString()} / {influentialTotal.toLocaleString()}
              </div>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div className="bg-brand-600 h-2 rounded-full" style={{ width: `${influentialPct}%` }} />
            </div>
          </div>
        </div>

        {/* Intent trend */}
        <div className="bg-white border border-gray-100 rounded-lg p-5 mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Citation Intent Trend Over Time</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={trendData} margin={{ right: 10 }}>
              <XAxis dataKey="year" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {Object.keys(INTENT_COLORS).map(intent => (
                <Line key={intent} type="monotone" dataKey={intent}
                  stroke={INTENT_COLORS[intent]} dot={false} strokeWidth={1.8} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Top venues */}
        <div className="bg-white border border-gray-100 rounded-lg p-5 mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Top Citing Venues</h3>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={data.top_venues} layout="vertical" margin={{ left: 10 }}>
              <XAxis type="number" tick={{ fontSize: 9 }} />
              <YAxis dataKey="venue" type="category" tick={{ fontSize: 9 }} width={190}
                tickFormatter={v => v?.slice(0, 40) || ''} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="count" fill="#3b82f6" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

      </div>
    </Layout>
  )
}
