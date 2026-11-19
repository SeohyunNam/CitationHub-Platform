import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import Layout from '../components/Layout'
import SearchBar from '../components/SearchBar'

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
      <button onClick={() => onPage(page + 1)} disabled={page === totalPages}
        className="px-3 py-1.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:bg-gray-50 transition-colors">
        Next
      </button>
    </div>
  )
}

function AuthorCard({ author }) {
  const { author_id, name, paper_count, total_citedby, top_field, top_affiliation, top_country } = author
  return (
    <Link href={`/authors/${encodeURIComponent(author_id)}`}
      className="block bg-white border border-gray-100 rounded-lg px-5 py-4 hover:border-brand-200 hover:shadow-sm transition-all">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-brand-700 leading-snug mb-1">{name || '(Unknown)'}</h3>
          <p className="text-xs text-gray-500 line-clamp-1">
            {[top_affiliation, top_country].filter(Boolean).join(' · ') || '\u2014'}
          </p>
          {top_field && (
            <span className="inline-block mt-2 text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">
              {top_field}
            </span>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-bold text-gray-800 tabular-nums">{Number(total_citedby).toLocaleString()}</div>
          <div className="text-xs text-gray-400">citations</div>
          <div className="text-xs text-gray-400 mt-1">{paper_count} paper{paper_count > 1 ? 's' : ''}</div>
        </div>
      </div>
    </Link>
  )
}

export default function AuthorsPage() {
  const router = useRouter()
  const { q = '' } = router.query

  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [page,    setPage]    = useState(1)

  useEffect(() => { setPage(1) }, [q])

  useEffect(() => {
    if (!router.isReady) return
    const params = new URLSearchParams({ q, page, limit: 20 })
    setLoading(true)
    fetch(`${API}/api/authors/search?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [router.isReady, q, page])

  return (
    <Layout>
      <Head><title>Author Search | CitationHub</title></Head>

      <div className="bg-white border-b border-gray-100 px-6 py-3">
        <div className="max-w-7xl mx-auto">
          <SearchBar initialValue={q} initialType="authors" />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-gray-500">
            {loading ? 'Loading...' : data ? (
              <><span className="font-semibold text-gray-800">{data.total.toLocaleString()}</span> authors</>
            ) : 'Search for an author by name'}
          </p>
        </div>

        {loading && (
          <div className="flex justify-center py-20">
            <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && data?.results?.length === 0 && (
          <div className="bg-white border border-gray-100 rounded-lg p-12 text-center text-gray-400 text-sm">
            No authors found matching your search.
          </div>
        )}

        {!loading && data?.results?.length > 0 && (
          <>
            <div className="space-y-2">
              {data.results.map(a => <AuthorCard key={a.author_id} author={a} />)}
            </div>
            <Pagination page={page} totalPages={data.total_pages}
              onPage={p => { setPage(p); window.scrollTo(0, 0) }} />
          </>
        )}
      </div>
    </Layout>
  )
}
