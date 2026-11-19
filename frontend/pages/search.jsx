import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import Layout from '../components/Layout'
import SearchBar from '../components/SearchBar'
import PaperCard from '../components/PaperCard'
import { hasAdvancedFilters, pickSearchQuery, qstr, searchParamsFrom } from '../lib/searchQuery'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function Pagination({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null
  const pages = []
  const start = Math.max(1, page - 2)
  const end   = Math.min(totalPages, page + 2)
  for (let i = start; i <= end; i++) pages.push(i)

  return (
    <div className="flex items-center justify-center gap-1 mt-8">
      <button onClick={() => onPage(page - 1)} disabled={page === 1}
        className="px-3 py-1.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:bg-gray-50 transition-colors">
        Previous
      </button>
      {start > 1 && <span className="px-1.5 text-gray-300 text-sm">…</span>}
      {pages.map(p => (
        <button key={p} onClick={() => onPage(p)}
          className={`px-3 py-1.5 rounded text-sm border transition-colors ${
            p === page
              ? 'bg-brand-700 text-white border-brand-700 font-medium'
              : 'text-gray-600 hover:bg-gray-50 border-gray-200'
          }`}>
          {p}
        </button>
      ))}
      {end < totalPages && <span className="px-1.5 text-gray-300 text-sm">…</span>}
      <button onClick={() => onPage(page + 1)} disabled={page === totalPages}
        className="px-3 py-1.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:bg-gray-50 transition-colors">
        Next
      </button>
    </div>
  )
}

export default function SearchPage() {
  const router  = useRouter()
  const q        = qstr(router.query.q)
  const field    = qstr(router.query.field)
  const country  = qstr(router.query.country)
  const journal  = qstr(router.query.journal)
  const title    = qstr(router.query.title)
  const author   = qstr(router.query.author)
  const yearMin  = qstr(router.query.year_min)
  const yearMax  = qstr(router.query.year_max)
  const advanced = hasAdvancedFilters(router.query)

  const [data,         setData]         = useState(null)
  const [filters,      setFilters]      = useState(null)
  const [loading,      setLoading]      = useState(false)
  const [page,         setPage]         = useState(1)
  const [localField,   setLocalField]   = useState('')
  const [localCountry, setLocalCountry] = useState('')
  const [localJournal, setLocalJournal] = useState('')

  const journalParam = localJournal || journal
  const advancedQuery = pickSearchQuery({ q, title, author, journal, year_min: yearMin, year_max: yearMax })

  useEffect(() => {
    fetch(`${API}/api/overview`)
      .then(r => r.json())
      .then(d => setFilters(d.filters))
      .catch(() => {})
  }, [])

  useEffect(() => {
    setLocalField(field || '')
    setLocalCountry(country || '')
    setPage(1)
  }, [field, country, journal, q, title, author, yearMin, yearMax])

  useEffect(() => {
    if (filters?.journals?.includes(journal)) {
      setLocalJournal(journal)
    } else {
      setLocalJournal('')
    }
  }, [journal, filters])

  useEffect(() => {
    if (!router.isReady) return
    const params = searchParamsFrom({
      q, title, author, year_min: yearMin, year_max: yearMax,
      field: localField, country: localCountry, journal: journalParam,
    }, { page, limit: 20 })
    setLoading(true)
    fetch(`${API}/api/search?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [router.isReady, q, title, author, yearMin, yearMax, localField, localCountry, journalParam, page])

  const applyFilters = () => {
    router.push({
      pathname: '/search',
      query: pickSearchQuery({
        ...advancedQuery,
        field: localField,
        country: localCountry,
        journal: localJournal || journal,
      }),
    }, undefined, { shallow: true })
    setPage(1)
  }

  const clearFilters = () => {
    setLocalField(''); setLocalCountry(''); setLocalJournal('')
    router.push({ pathname: '/search', query: advancedQuery }, undefined, { shallow: true })
  }

  const exportCSV = () => {
    const params = searchParamsFrom({
      q, title, author, year_min: yearMin, year_max: yearMax,
      field: localField, country: localCountry, journal: journalParam,
    })
    window.open(`${API}/api/export/search?${params}`)
  }

  const yearLabel = yearMin && yearMax
    ? `${yearMin}–${yearMax}`
    : yearMin
      ? `since ${yearMin}`
      : yearMax
        ? `through ${yearMax}`
        : ''
  const advancedBits = [
    title && `title “${title}”`,
    author && `author “${author}”`,
    journal && !localJournal && `journal “${journal}”`,
    yearLabel && yearLabel,
  ].filter(Boolean)

  return (
    <Layout>
      <Head><title>Search — CitationHub</title></Head>

      {/* Top bar */}
      <div className="bg-white border-b border-gray-100 px-6 py-3">
        <div className="max-w-7xl mx-auto">
          <SearchBar initialValue={q} />
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 flex gap-6">

        {/* Sidebar */}
        <aside className="w-56 shrink-0 hidden md:block">
          <div className="bg-white border border-gray-100 rounded-lg p-4 sticky top-20">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Filters
            </h3>

            {filters && (
              <>
                <FilterSelect label="Field"   options={filters.fields}              value={localField}   onChange={setLocalField} />
                <FilterSelect label="Country" options={filters.countries}           value={localCountry} onChange={setLocalCountry} />
                <FilterSelect label="Journal" options={filters.journals.slice(0,200)} value={localJournal} onChange={setLocalJournal} />
              </>
            )}

            <button onClick={applyFilters}
              className="w-full mt-3 py-2 bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium rounded-lg transition-colors">
              Apply
            </button>
            <button onClick={clearFilters}
              className="w-full mt-2 py-2 border border-gray-200 hover:bg-gray-50 text-gray-600 text-sm font-medium rounded-lg transition-colors">
              Clear
            </button>
          </div>
        </aside>

        {/* Results */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              {loading ? 'Loading…' : data ? (
                <><span className="font-semibold text-gray-800">{data.total.toLocaleString()}</span> results</>
              ) : ''}
            </p>
            <div className="flex items-center gap-3">
              {advanced && (
                <Link
                  href={`/search/advanced?${searchParamsFrom(advancedQuery)}`}
                  className="text-xs text-brand-700 underline hover:text-brand-800"
                >
                  Edit advanced search
                </Link>
              )}
              <button onClick={exportCSV}
                className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 hover:border-gray-300 px-3 py-1.5 rounded-md transition-colors">
                Export CSV
              </button>
            </div>
          </div>

          {advancedBits.length > 0 && (
            <p className="text-xs text-gray-500 mb-4">
              Advanced filters: {advancedBits.join(' · ')}
            </p>
          )}

          {loading && (
            <div className="flex justify-center py-20">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {!loading && data?.results?.length === 0 && (
            <div className="bg-white border border-gray-100 rounded-lg p-12 text-center text-gray-400 text-sm">
              No papers found matching your search.
            </div>
          )}

          {!loading && data?.results?.length > 0 && (
            <>
              <div className="space-y-2">
                {data.results.map(paper => (
                  <PaperCard key={paper.seed_paper_id} paper={paper} />
                ))}
              </div>
              <Pagination page={page} totalPages={data.total_pages}
                onPage={p => { setPage(p); window.scrollTo(0, 0) }} />
            </>
          )}
        </div>
      </div>
    </Layout>
  )
}

function FilterSelect({ label, options, value, onChange }) {
  return (
    <div className="mb-3">
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full text-xs border border-gray-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white text-gray-700">
        <option value="">All</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}
