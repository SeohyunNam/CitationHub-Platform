import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import Layout from '../../components/Layout'
import SearchTabs from '../../components/SearchTabs'
import { pickSearchQuery, qstr } from '../../lib/searchQuery'

const YEAR_PRESETS = [
  { id: 'any',        label: 'Any date',    min: null, max: null },
  { id: 'since2020',  label: 'Since 2020',  min: 2020, max: null },
  { id: 'y2015',      label: '2015–2019',   min: 2015, max: 2019 },
  { id: 'y2010',      label: '2010–2014',   min: 2010, max: 2014 },
  { id: 'before2010', label: 'Before 2010', min: null, max: 2009 },
  { id: 'custom',     label: 'Custom dates', min: null, max: null },
]

function inferPreset(yearMin, yearMax) {
  const min = yearMin === '' ? null : Number(yearMin)
  const max = yearMax === '' ? null : Number(yearMax)
  if (min == null && max == null) return 'any'
  const match = YEAR_PRESETS.find(p => p.id !== 'custom' && p.min === min && p.max === max)
  return match ? match.id : 'custom'
}

function parseYear(value) {
  const n = Number(String(value).trim())
  if (!Number.isInteger(n) || n < 1900 || n > 2100) return null
  return n
}

function Field({ id, label, hint, value, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-gray-900">{label}</label>
      <p className="text-sm text-gray-400 mt-0.5 mb-2">{hint}</p>
      <input
        id={id}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
      />
    </div>
  )
}

export default function AdvancedSearchPage() {
  const router = useRouter()
  const [keywords, setKeywords]   = useState('')
  const [title, setTitle]         = useState('')
  const [author, setAuthor]       = useState('')
  const [journal, setJournal]     = useState('')
  const [yearPreset, setYearPreset] = useState('any')
  const [startYear, setStartYear] = useState('')
  const [endYear, setEndYear]     = useState('')

  useEffect(() => {
    if (!router.isReady) return
    const q = router.query
    setKeywords(qstr(q.q))
    setTitle(qstr(q.title))
    setAuthor(qstr(q.author))
    setJournal(qstr(q.journal))
    const ymin = qstr(q.year_min)
    const ymax = qstr(q.year_max)
    setStartYear(ymin)
    setEndYear(ymax)
    setYearPreset(inferPreset(ymin, ymax))
  }, [router.isReady, router.asPath])

  const handleSubmit = (e) => {
    e.preventDefault()
    const query = pickSearchQuery({
      q: keywords,
      title,
      author,
      journal,
    })

    if (yearPreset === 'custom') {
      let min = parseYear(startYear)
      let max = parseYear(endYear)
      if (min != null && max != null && min > max) {
        ;[min, max] = [max, min]
      }
      if (min != null) query.year_min = String(min)
      if (max != null) query.year_max = String(max)
    } else {
      const preset = YEAR_PRESETS.find(p => p.id === yearPreset)
      if (preset?.min != null) query.year_min = String(preset.min)
      if (preset?.max != null) query.year_max = String(preset.max)
    }

    router.push({ pathname: '/search', query })
  }

  return (
    <Layout>
      <Head><title>Advanced search — CitationHub</title></Head>

      <div className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <nav className="text-sm text-gray-500 mb-4">
            <Link href="/" className="hover:text-gray-800">Home</Link>
            <span className="mx-2 text-gray-300">›</span>
            <span className="text-gray-800">Advanced Search</span>
          </nav>

          <div className="mb-8"><SearchTabs active="advanced" /></div>

          <h1 className="text-3xl font-bold text-gray-900 mb-6">Advanced search</h1>

          <div className="flex items-start gap-3 border border-brand-100 bg-brand-50 rounded-md px-4 py-3 mb-8 text-sm text-gray-700">
            <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-brand-600 text-white text-xs font-bold flex items-center justify-center">i</span>
            <p>
              All filled fields are combined. Within each field, every word you type must appear
              (for example, <span className="font-medium">deep learning</span> matches titles that
              contain both words). Date published is the paper’s cover year, not the year it was cited.
              Author names in this dataset look like <span className="font-medium">Studenski S.</span>
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-7">
            <Field
              id="adv-keywords"
              label="Keywords"
              hint="deep learning"
              value={keywords}
              onChange={setKeywords}
            />
            <Field
              id="adv-title"
              label="Title"
              hint="Gait speed and survival in older adults"
              value={title}
              onChange={setTitle}
            />
            <Field
              id="adv-author"
              label="Author(s)"
              hint="Studenski S."
              value={author}
              onChange={setAuthor}
            />
            <Field
              id="adv-journal"
              label="In journal(s)"
              hint="Nature"
              value={journal}
              onChange={setJournal}
            />

            <fieldset>
              <legend className="text-sm font-semibold text-gray-900 mb-3">Date published</legend>
              <div className="space-y-2.5">
                {YEAR_PRESETS.map(p => (
                  <label key={p.id} className="flex items-center gap-2.5 text-sm text-gray-800 cursor-pointer">
                    <input
                      type="radio"
                      name="year-preset"
                      value={p.id}
                      checked={yearPreset === p.id}
                      onChange={() => setYearPreset(p.id)}
                      className="accent-brand-700"
                    />
                    {p.label}
                  </label>
                ))}
              </div>

              <div className={`mt-3 ml-2 pl-5 border-l-2 border-gray-200 ${yearPreset === 'custom' ? '' : 'opacity-50'}`}>
                <div className="flex flex-wrap gap-6">
                  <div>
                    <label htmlFor="adv-year-start" className="block text-sm text-gray-700 mb-1">Start year (YYYY)</label>
                    <input
                      id="adv-year-start"
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={startYear}
                      disabled={yearPreset !== 'custom'}
                      onChange={e => setStartYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      className="w-28 border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white disabled:bg-gray-50"
                    />
                  </div>
                  <div>
                    <label htmlFor="adv-year-end" className="block text-sm text-gray-700 mb-1">End year (YYYY)</label>
                    <input
                      id="adv-year-end"
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={endYear}
                      disabled={yearPreset !== 'custom'}
                      onChange={e => setEndYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      className="w-28 border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white disabled:bg-gray-50"
                    />
                  </div>
                </div>
              </div>
            </fieldset>

            <button
              type="submit"
              className="inline-flex items-center gap-2 bg-brand-700 hover:bg-brand-800 text-white font-medium rounded-lg px-5 py-2.5 text-sm transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
              </svg>
              Search
            </button>
          </form>
        </div>
      </div>
    </Layout>
  )
}
