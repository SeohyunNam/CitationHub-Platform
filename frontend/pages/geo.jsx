import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Head from 'next/head'
import Layout from '../components/Layout'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { MAX_BUBBLES } from '../lib/mapLayer'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Served from frontend/public; only used for point layers the backend does not send yet.
const GEO_POINTS_FALLBACK = '/data/geo_points.json'

const VIEWS = [
  {
    id: 'countries', label: 'By country', title: 'Country',
    describe: () =>
      'Hover over a country to see the paper count. Darker = more papers. '
      + 'Zoom in to reveal more country names.',
  },
  {
    id: 'cities', label: 'By city', title: 'City',
    describe: n =>
      `The ${n.toLocaleString()} busiest cities. Bubble size = paper count; hover for `
      + 'details. Zoom in to reveal more city names.',
  },
  {
    id: 'affiliations', label: 'By affiliation', title: 'Affiliation',
    describe: n =>
      `The ${n.toLocaleString()} busiest affiliations, each placed on its city — the `
      + 'dataset locates them no more precisely, so institutions sharing a city are '
      + 'fanned out around it. Hover for the full name; zoom in to reveal more.',
  },
]

const ChoroplethMap = dynamic(() => import('../components/ChoroplethMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full flex items-center justify-center bg-gray-50" style={{ minHeight: 400 }}>
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  ),
})

function TopBar({ data, label, color }) {
  const top15 = (data || []).slice(0, 15)
  return (
    <div className="bg-white border border-gray-100 rounded-lg p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{label}</h3>
      {top15.length === 0
        ? <p className="text-xs text-gray-400">No data available.</p>
        : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={top15} layout="vertical">
              <XAxis type="number" tick={{ fontSize: 9 }} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 9 }} width={120}
                tickFormatter={v => v?.slice(0, 22) || ''} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="count" fill={color} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )
      }
    </div>
  )
}

export default function GeoPage() {
  const [geo,     setGeo]     = useState(null)
  const [points,  setPoints]  = useState({ cities: [], affiliations: [] })
  const [view,    setView]    = useState('countries')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API}/api/geo`)
      .then(r => r.json())
      .then(d => {
        setGeo(d)
        setLoading(false)

        const fromApi = {
          cities:       Array.isArray(d.city_points) ? d.city_points : [],
          affiliations: Array.isArray(d.affiliation_points) ? d.affiliation_points : [],
        }
        if (fromApi.cities.length > 0 && fromApi.affiliations.length > 0) {
          setPoints(fromApi)
          return
        }
        // A backend deployed before these fields existed sends neither, and one deployed
        // between the two changes sends only cities. The checked-in snapshot fills in
        // whichever layer is missing so the map stays usable until the server catches up.
        return fetch(GEO_POINTS_FALLBACK)
          .then(r => r.json())
          .then(snapshot => setPoints({
            cities: fromApi.cities.length > 0 ? fromApi.cities : (snapshot.cities || []),
            affiliations: fromApi.affiliations.length > 0
              ? fromApi.affiliations
              : (snapshot.affiliations || []),
          }))
      })
      .catch(() => setLoading(false))
  }, [])

  const active       = VIEWS.find(v => v.id === view) || VIEWS[0]
  const activePoints = points[view] || []
  // The map plots only the busiest MAX_BUBBLES points, so the caption counts those.
  const plotted      = Math.min(activePoints.length, MAX_BUBBLES)

  return (
    <Layout>
      <Head><title>Geographic Map | CitationHub</title></Head>
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-xl font-bold text-gray-900 mb-1">Geographic Distribution</h1>
        <p className="text-sm text-gray-400 mb-6">
          Where are the seed papers' authors and affiliations located?
        </p>

        {loading && (
          <div className="flex justify-center items-center h-60">
            <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && !geo && (
          <p className="text-sm text-gray-400 text-center py-20">Failed to load geo data.</p>
        )}

        {!loading && geo && (
          <>
            <div className="bg-white border border-gray-100 rounded-lg overflow-hidden mb-6">
              <div className="px-5 pt-4 pb-1 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">
                    World Map &middot; Papers by {active.title}
                  </h3>
                  <p className="text-xs text-gray-400 mb-2">
                    {active.describe(plotted)}
                  </p>
                </div>
                <div className="inline-flex rounded-md border border-gray-200 overflow-hidden shrink-0">
                  {VIEWS.map(v => (
                    <button
                      key={v.id}
                      onClick={() => setView(v.id)}
                      disabled={v.id !== 'countries' && (points[v.id] || []).length === 0}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                        view === v.id
                          ? 'bg-brand-600 text-white'
                          : 'bg-white text-gray-500 hover:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-white'
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
              <ChoroplethMap
                countryCounts={geo.country_counts || []}
                points={activePoints}
                view={view}
              />
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <TopBar data={geo.country_counts}     label="Top Countries"    color="#3b82f6" />
              <TopBar data={geo.city_counts}         label="Top Cities"       color="#8b5cf6" />
              <TopBar data={geo.affiliation_counts}  label="Top Affiliations" color="#f59e0b" />
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
