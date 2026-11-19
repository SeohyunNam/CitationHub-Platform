const INTENT_STYLE = {
  background:   'bg-slate-100 text-slate-600',
  uses:         'bg-green-50 text-green-700',
  similarities: 'bg-blue-50 text-blue-700',
  motivation:   'bg-amber-50 text-amber-700',
  differences:  'bg-red-50 text-red-700',
  future_work:  'bg-purple-50 text-purple-700',
  extends:      'bg-cyan-50 text-cyan-700',
}

export default function PaperCard({ paper }) {
  const {
    seed_paper_id, title, doi, journal, author,
    country, field, cover_date, citedby_count,
  } = paper

  const year = cover_date?.slice(0, 4)
  const doiUrl = doi ? `https://doi.org/${doi}` : null

  return (
    <div className="bg-white border border-gray-100 rounded-lg px-5 py-4 hover:border-gray-200 hover:shadow-sm transition-all">
      {doiUrl ? (
        <a href={doiUrl} target="_blank" rel="noopener noreferrer">
          <h3 className="text-sm font-semibold text-brand-700 hover:underline leading-snug mb-1.5 line-clamp-2">
            {title || '(No title)'}
          </h3>
        </a>
      ) : (
        <h3 className="text-sm font-semibold text-gray-800 leading-snug mb-1.5 line-clamp-2">
          {title || '(No title)'}
        </h3>
      )}

      <p className="text-xs text-gray-500 mb-2.5 line-clamp-1">
        {[author, journal, year].filter(Boolean).join(' · ')}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {field && (
          <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">
            {field}
          </span>
        )}
        {country && (
          <span className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-600 font-medium">
            {country}
          </span>
        )}
        <span className="text-xs px-2 py-0.5 rounded bg-gray-50 text-gray-500 font-medium ml-auto">
          Cited by {Number(citedby_count).toLocaleString()}
        </span>
        {doi && (
          <a
            href={`https://doi.org/${doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-brand-600 hover:underline"
          >
            DOI
          </a>
        )}
      </div>
    </div>
  )
}
