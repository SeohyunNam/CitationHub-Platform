import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import Layout from '../components/Layout'
import SearchBar from '../components/SearchBar'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const STAT_ITEMS = [
  { key: 'seed_papers',     label: 'Seed Papers' },
  { key: 'citation_events', label: 'Citation Events' },
  { key: 'citing_papers',   label: 'Citing Papers' },
  { key: 'authors',         label: 'Authors' },
  { key: 'journals',        label: 'Journals' },
  { key: 'countries',       label: 'Countries' },
  { key: 'fields',          label: 'Research Fields' },
  { key: 'intents',         label: 'Citation Intents' },
]

export default function HomePage() {
  const [overview, setOverview] = useState(null)

  useEffect(() => {
    fetch(`${API}/api/overview`)
      .then(r => r.json())
      .then(d => setOverview(d.overview))
      .catch(() => {})
  }, [])
  return (
    <Layout>
      <Head><title>CitationHub — Explore Citation Networks</title></Head>

      {/* Hero */}
      <section className="bg-white border-b border-gray-100 py-16 px-6">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3 leading-tight">
            Explore Influential Papers<br className="hidden sm:block" /> & Citation Networks
          </h1>
          <p className="text-gray-500 text-base mb-8 leading-relaxed">
            CitationHub indexes top 5% cited papers with rich citation intent analysis,
            author profiles, knowledge graphs, SPARQL querying, and geographic insights.
            Switch the search box below to look up papers or authors.
          </p>
          <SearchBar large />
        </div>
      </section>

      {/* Stats */}
      {overview && (
        <section className="max-w-7xl mx-auto px-6 py-10">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-5">
            Dataset Overview
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {STAT_ITEMS.map(({ key, label }) => (
              <div key={key} className="bg-white rounded-lg border border-gray-100 px-5 py-4">
                <div className="text-2xl font-bold text-brand-700 tabular-nums">
                  {(overview[key] ?? 0).toLocaleString()}
                </div>
                <div className="text-xs text-gray-500 mt-1 font-medium">{label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Navigation cards */}
      <section className="max-w-7xl mx-auto px-6 pb-16">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-5">
          Explore
        </h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            {
              href: '/search',
              title: 'Browse Papers',
              desc: 'Search and filter top-cited seed papers by title, DOI, field, country, or journal.',
            },
            {
              href: '/authors',
              title: 'Author Search',
              desc: 'Look up authors and explore each author\u2019s papers and citation patterns.',
            },
            {
              href: '/analytics',
              title: 'Citation Analytics',
              desc: 'View citation intent trends over time, top citing venues, and influential citation statistics.',
            },
            {
              href: '/geo',
              title: 'Geographic Map',
              desc: 'See where top-cited research comes from on an interactive choropleth world map.',
            },
            {
              href: '/kg',
              title: 'Knowledge Graph',
              desc: 'Interactively explore the heterogeneous scholarly knowledge graph for any seed paper.',
            },
            {
              href: '/sparql',
              title: 'SPARQL Explorer',
              desc: 'Query the 25M-triple knowledge graph directly with SPARQL.',
            },
          ].map(({ href, title, desc }) => (
            <Link key={href} href={href}
              className="bg-white rounded-lg border border-gray-100 hover:border-brand-200 hover:shadow-sm transition-all p-6 group">
              <div className="font-semibold text-gray-900 mb-2 group-hover:text-brand-700 transition-colors">
                {title}
              </div>
              <div className="text-sm text-gray-500 leading-relaxed">{desc}</div>
            </Link>
          ))}
        </div>
      </section>
    </Layout>
  )
}
