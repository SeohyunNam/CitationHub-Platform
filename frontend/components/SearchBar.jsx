import { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import clsx from 'clsx'

export default function SearchBar({ initialValue = '', large = false, initialType = 'papers' }) {
  const [q, setQ]       = useState(initialValue)
  const [type, setType] = useState(initialType)
  const router = useRouter()

  const handleSubmit = (e) => {
    e.preventDefault()
    const path = type === 'authors' ? '/authors' : '/search'
    router.push(`${path}?q=${encodeURIComponent(q)}`)
  }

  return (
    <div className="w-full">
      <div className="flex gap-1 mb-2">
        {[
          { id: 'papers',  label: 'Papers' },
          { id: 'authors', label: 'Authors' },
        ].map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setType(t.id)}
            className={clsx(
              'px-3 py-1 rounded-md text-sm font-medium transition-colors',
              type === t.id
                ? 'bg-brand-700 text-white'
                : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex w-full gap-2">
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={type === 'authors' ? 'Search by author name...' : 'Search by title or DOI...'}
          className={`flex-1 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent bg-white text-gray-900 placeholder-gray-400 ${
            large ? 'px-5 py-3.5 text-base shadow-sm' : 'px-4 py-2.5 text-sm'
          }`}
        />
        <button
          type="submit"
          className={`shrink-0 bg-brand-700 hover:bg-brand-800 text-white font-medium rounded-lg transition-colors ${
            large ? 'px-7 py-3.5 text-base' : 'px-5 py-2.5 text-sm'
          }`}
        >
          Search
        </button>
      </form>

      {type === 'papers' && (
        <div className={`mt-2 flex gap-4 ${large ? 'text-sm' : 'text-xs'}`}>
          <Link
            href={q.trim() ? `/search/advanced?q=${encodeURIComponent(q)}` : '/search/advanced'}
            className="text-brand-700 underline hover:text-brand-800"
          >
            Advanced search
          </Link>
          <Link href="/search/citation" className="text-brand-700 underline hover:text-brand-800">
            Citation search
          </Link>
        </div>
      )}
    </div>
  )
}
