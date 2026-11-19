import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import clsx from 'clsx'
import Layout from '../../components/Layout'
import SearchTabs from '../../components/SearchTabs'
import { qstr } from '../../lib/searchQuery'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const DOCS_URL = 'https://github.com/SeohyunNam/CitationHub-Platform/blob/main/docs/evaluation-dataset.md'

// Query filled in when the page is opened without one: the full query of event 194
// (Background), the default example, whose cited paper ranks C1 #31, C2 #1, C3 #1
// among its 100 candidates. Its context names neither the cited authors nor the year, so the gain
// is not an author-name match. Nothing is ranked until Search is pressed.
const EXAMPLE_EVENT = '194'
const DEFAULT_SEARCH = {
  title: 'The role of DNA hydroxymethylation and TET enzymes in placental development and pregnancy outcome',
  context: 'The TETs also convert 5hmC into 5-formylcytosine (5fC) and 5-carboxylcytosine (5caC), which act as intermediates in the active DNA demethylation process [21].',
  intent: 'background', field: 'Multidisciplinary',
}

// Two texts are the same once case and runs of whitespace are ignored (as the backend matches).
function sameText(a, b) {
  const norm = t => (t || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  return norm(a) === norm(b)
}

const CONDITIONS = [
  { id: 'C1', label: 'C1 · Title', help: 'Citing-paper title only' },
  { id: 'C2', label: 'C2 · Title + Context', help: 'Title fused with the citation context (weight 0.75)' },
  { id: 'C3', label: 'C3 · Title + Context + Intent', help: 'Title fused with the context encoded together with its intent' },
]

async function getJSON(url) {
  const r = await fetch(url)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.detail || `Request failed (${r.status})`)
  return d
}

function IntentBadge({ intent, meta }) {
  const info = meta?.intents?.find(i => i.id === intent)
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{ color: info?.color || '#64748b' }}>
      <span className="w-2 h-2 rounded-full" style={{ background: info?.color || '#94a3b8' }} />
      {info?.label || intent}
    </span>
  )
}

function RankTriple({ ranks, active, total }) {
  return (
    <div className="flex flex-wrap gap-2">
      {CONDITIONS.map(c => (
        <span key={c.id} className={clsx('text-xs tabular-nums rounded border px-2 py-1',
          c.id === active ? 'border-brand-700 text-brand-700 font-semibold bg-brand-50' : 'border-gray-200 text-gray-600')}>
          {c.id} <span className="font-semibold">#{ranks?.[c.id] ?? '—'}</span>{total ? ` / ${total}` : ''}
        </span>
      ))}
    </div>
  )
}

function Evidence({ evidence, meta }) {
  if (!evidence?.contexts?.length) {
    return <p className="text-xs text-gray-400 mt-2">No other citation context with this intent in IDCite.</p>
  }
  return (
    <div className="mt-3 space-y-3">
      {evidence.contexts.map((c, k) => (
        <div key={k} className="border-l-2 pl-3" style={{ borderColor: meta?.intents?.find(i => i.id === c.intent)?.color || '#e5e7eb' }}>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <IntentBadge intent={c.intent} meta={meta} />
            <span className="text-[11px] text-gray-500 truncate max-w-md">cited by <span className="italic">{c.citing_title}</span>{c.citing_year ? ` (${c.citing_year})` : ''}</span>
          </div>
          {c.contexts.slice(0, 2).map((ctx, j) => (
            <p key={j} className="text-[13px] leading-relaxed text-gray-700 mb-1">{ctx}</p>
          ))}
        </div>
      ))}
    </div>
  )
}

function ResultCard({ r, meta, condition, intent, open, onToggle }) {
  return (
    <li className={clsx('bg-white border rounded-lg p-4', r.is_cited ? 'border-brand-700 ring-1 ring-brand-700' : 'border-gray-200')}>
      <div className="flex gap-3">
        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold bg-gray-900 text-white">{r.rank}</div>
        <div className="min-w-0 flex-1">
          {r.is_cited && (
            <span className="inline-block mb-1 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
              Paper cited in this citation event
            </span>
          )}
          <div>
            <Link href={`/papers/${encodeURIComponent(r.seed_paper_id)}`} className="font-semibold text-gray-900 hover:text-brand-700 leading-snug">
              {r.title}
            </Link>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {[r.author, r.journal, r.year, r.field].filter(Boolean).join(' · ')} (cited {r.citedby_count.toLocaleString()})
          </p>
          <p className="text-[11px] text-gray-500 mt-1 tabular-nums">
            score {r.scores[condition].toFixed(4)} · ranks C1 #{r.ranks.C1} · C2 #{r.ranks.C2} · C3 #{r.ranks.C3}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(meta?.intents || []).filter(i => r.intent_counts[i.id] > 0).map(i => (
              <span key={i.id} className={clsx('text-[11px] rounded-full px-2 py-0.5 border', i.id === intent ? 'font-semibold' : 'opacity-60')}
                style={{ borderColor: i.color, color: i.color }}>
                {i.label} {r.intent_counts[i.id].toLocaleString()}
              </span>
            ))}
          </div>
          <div className="flex gap-4 mt-2">
            <button onClick={onToggle} className="text-xs text-brand-700 hover:underline">
              {open ? 'Hide' : 'Show'} citation contexts
            </button>
            <Link href={{ pathname: '/network', query: { paper_id: r.seed_paper_id, intents: intent } }}
              className="text-xs text-brand-700 hover:underline">
              Open in Citation Network
            </Link>
          </div>
          {open && <Evidence evidence={r.evidence} meta={meta} />}
        </div>
      </div>
    </li>
  )
}

/** Illustrative citation events, one per intent, as compact chips inside the Query box. */
function ExampleChips({ examples, meta, active, onChoose }) {
  if (!examples?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-gray-500 mr-1">Examples:</span>
      {examples.map(e => {
        const info = meta?.intents?.find(i => i.id === e.intent)
        const on = String(e.idx) === active
        return (
          <button key={e.idx} type="button" onClick={() => onChoose(e)}
            title={`${e.title}\n\n${e.context}${e.reference_ranks ? `\n\nCited paper: C1 #${e.reference_ranks.C1} → C2 #${e.reference_ranks.C2}` : ''}`}
            className={clsx('inline-flex items-center gap-1 text-[11px] rounded-full border px-2 py-0.5 transition-colors',
              on ? 'font-semibold bg-brand-50' : 'bg-white hover:bg-gray-50')}
            style={{ borderColor: info?.color || '#d1d5db', color: info?.color || '#64748b' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: info?.color || '#94a3b8' }} />
            {info?.label || e.intent}
          </button>
        )
      })}
    </div>
  )
}

/** Title box that suggests full titles of evaluation-set events as you type. */
function TitleAutocomplete({ value, onChange, onPick, intent, field, meta }) {
  const [items, setItems] = useState([])
  const [openList, setOpenList] = useState(false)
  const [active, setActive] = useState(-1)
  const [typed, setTyped] = useState(false) // only typing (not filling the form) opens suggestions

  useEffect(() => {
    const text = value.trim()
    if (!typed || text.length < 3) { setItems([]); return }
    let stale = false
    const t = setTimeout(() => {
      const p = new URLSearchParams({ title: text, limit: '8' })
      if (intent) p.set('intent', intent)
      if (field) p.set('field', field)
      getJSON(`${API}/api/citation-search/test/queries?${p}`)
        .then(d => { if (!stale) { setItems(d.results); setActive(-1); setOpenList(true) } })
        .catch(() => { if (!stale) setItems([]) })
    }, 250)
    return () => { stale = true; clearTimeout(t) }
  }, [value, typed, intent, field])

  const pick = e => { setOpenList(false); setTyped(false); setItems([]); onPick(e) }
  const onKeyDown = ev => {
    if (!openList || !items.length) return
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(a => (a + 1) % items.length) }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(a => (a <= 0 ? items.length : a) - 1) }
    else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); pick(items[active]) }
    else if (ev.key === 'Escape') setOpenList(false)
  }
  const show = openList && typed && items.length > 0

  return (
    <div className="relative">
      <input id="cs-title" value={value} autoComplete="off"
        role="combobox" aria-expanded={show} aria-controls="cs-title-suggestions" aria-autocomplete="list"
        onChange={ev => { setTyped(true); onChange(ev.target.value) }}
        onKeyDown={onKeyDown}
        onFocus={() => items.length && setOpenList(true)}
        onBlur={() => setOpenList(false)}
        placeholder="Start typing a title, e.g. Stem cells"
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
      {show && (
        <ul id="cs-title-suggestions" role="listbox"
          className="absolute z-20 left-0 right-0 mt-1 max-h-80 overflow-auto bg-white border border-gray-200 rounded shadow-lg divide-y divide-gray-100">
          {items.map((e, k) => (
            <li key={e.idx} role="option" aria-selected={k === active}
              onMouseDown={ev => { ev.preventDefault(); pick(e) }}
              onMouseEnter={() => setActive(k)}
              className={clsx('px-3 py-2 cursor-pointer', k === active && 'bg-brand-50')}>
              <div className="flex flex-wrap items-center gap-2">
                <IntentBadge intent={e.intent} meta={meta} />
                <span className="text-[11px] text-gray-400">{e.field}</span>
              </div>
              <p className="text-[13px] font-medium text-gray-900 leading-snug">{e.title}</p>
              <p className="text-xs text-gray-500 line-clamp-1">{e.context}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function CitationSearchPage() {
  const router = useRouter()
  const [meta, setMeta] = useState(null)        // intents, colors, descriptions
  const [testMeta, setTestMeta] = useState(null) // evaluation set summary
  const [examples, setExamples] = useState([])   // one illustrative event per intent
  const [metaError, setMetaError] = useState('')

  // The query of a citation event: citing-paper title x_t,
  // citation context x_c and citation intent i.
  const [titleQ, setTitleQ] = useState('')
  const [contextQ, setContextQ] = useState('')
  const [intent, setIntent] = useState('')
  const [field, setField] = useState('')

  const [searchMsg, setSearchMsg] = useState('') // result of Search when it finds no single event
  const [run, setRun] = useState({ loading: false, data: null, error: '' })
  const [open, setOpen] = useState({})
  const [showEvidence, setShowEvidence] = useState(false)
  // False during server rendering and the first client render, so both produce the same
  // HTML; the router can already be "ready" on the client before hydration finishes.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    getJSON(`${API}/api/citation-search/meta`).then(setMeta).catch(() => setMetaError('Could not reach the CitationHub API.'))
    getJSON(`${API}/api/citation-search/test/meta`).then(setTestMeta).catch(() => {})
    getJSON(`${API}/api/citation-search/test/examples`).then(d => setExamples(d.results)).catch(() => {})
  }, [])

  const bare = mounted && router.isReady && Object.keys(router.query).length === 0
  // Opened without a query, the form holds the example query (no event is ranked yet).
  const q = bare ? DEFAULT_SEARCH : router.query
  const event = qstr(q.event)
  const condition = CONDITIONS.some(c => c.id === qstr(q.condition)) ? qstr(q.condition) : 'C2'

  // URL → form
  useEffect(() => {
    if (!router.isReady || !mounted) return
    setTitleQ(qstr(q.title)); setContextQ(qstr(q.context)); setIntent(qstr(q.intent)); setField(qstr(q.field))
    setSearchMsg('')
  }, [router.isReady, mounted, qstr(q.title), qstr(q.context), qstr(q.intent), qstr(q.field)])

  // URL → ranking of the selected citation event
  useEffect(() => {
    if (!router.isReady || event === '') { setRun({ loading: false, data: null, error: '' }); return }
    setRun(s => ({ ...s, loading: true, error: '' }))
    setOpen({})
    setShowEvidence(false)
    getJSON(`${API}/api/citation-search/test/queries/${encodeURIComponent(event)}?condition=${condition}`)
      .then(d => {
        setRun({ loading: false, data: d, error: '' })
        // The form shows the full title and context of the ranked event; Citation intent keeps the
        // form's choice (All intents by default), since the event's own intent is used for ranking.
        setTitleQ(d.query.title); setContextQ(d.query.context)
      })
      .catch(e => setRun({ loading: false, data: null, error: e.message }))
  }, [router.isReady, event, condition])

  const push = (changes, scrollTo) => {
    const next = { ...q, ...changes }
    for (const k of Object.keys(next)) {
      if (next[k] === '' || next[k] == null) delete next[k]
    }
    router.push({ pathname: '/search/citation', query: next }, undefined, { scroll: false })
      .then(() => scrollTo && document.getElementById(scrollTo)?.scrollIntoView({ behavior: 'smooth' }))
  }

  // Use one citation event as the query: its full title, full context and intent, ranked at once.
  const chooseEvent = e => {
    setSearchMsg('')
    push({
      q: '', page: '', title: e.title, context: e.context, intent: e.intent, field: e.field,
      event: String(e.idx), condition: '',
    }, 'cs-results')
  }
  // Search runs only on a query that exists in the evaluation set: the full citing paper title
  // and the full citation context of one citation event, exactly (case and spacing ignored).
  // Partial text is for the title suggestions, not for Search.
  const canSearch = titleQ.trim() !== '' && contextQ.trim() !== ''
  const submit = async e => {
    e.preventDefault()
    if (!canSearch) {
      setSearchMsg('Search needs the full title and the full citation context of a citation event. Pick an example or a title suggestion.')
      return
    }
    const p = new URLSearchParams({ title: titleQ.trim(), context: contextQ.trim(), limit: '50' })
    if (intent) p.set('intent', intent)
    if (field) p.set('field', field)
    try {
      const d = await getJSON(`${API}/api/citation-search/test/queries?${p}`)
      const exact = d.results.filter(r => sameText(r.title, titleQ) && sameText(r.context, contextQ))
      if (exact.length === 1) chooseEvent(exact[0])
      else if (exact.length === 0) {
        setSearchMsg('This is not the full title and full citation context of a citation event in the evaluation set. Pick an example or a title suggestion.')
      } else {
        setSearchMsg(`${exact.length} citation events have this title and context. Choose their citation intent.`)
      }
    } catch (err) {
      setSearchMsg(err.message)
    }
  }
  const clear = () => { setTitleQ(''); setContextQ(''); setIntent(''); setField(''); setSearchMsg('') }
  // Back to the page as first opened: the example query in the form, nothing ranked yet.
  const backToExample = () => {
    setTitleQ(DEFAULT_SEARCH.title); setContextQ(DEFAULT_SEARCH.context)
    setIntent(DEFAULT_SEARCH.intent); setField(DEFAULT_SEARCH.field)
    router.push({ pathname: '/search/citation' }, undefined, { scroll: false })
  }

  const data = run.data
  const total = testMeta?.n_candidates || 100
  const csvHref = data ? `${API}/api/citation-search/test/queries/${data.query.idx}/candidates.csv?condition=${condition}` : '#'

  return (
    <Layout>
      <Head><title>Citation search — CitationHub</title></Head>

      <div className="bg-white border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-6 pt-8 pb-4">
          <nav className="text-sm text-gray-500 mb-4">
            <Link href="/" className="hover:text-gray-800">Home</Link>
            <span className="mx-2 text-gray-300">›</span>
            <span className="text-gray-800">Citation Search</span>
          </nav>
          <SearchTabs active="citation" />
        </div>
      </div>

      <div className="bg-gray-100">
        <div className="max-w-7xl mx-auto px-6 py-8 grid lg:grid-cols-[minmax(0,1fr)_320px] gap-8">
          {/* ── Find a citation event ───────────────────────────── */}
          <div className="space-y-4 self-start min-w-0">
            <form onSubmit={submit} className="bg-white rounded p-6 space-y-5">
              <div>
                <h1 className="text-lg font-semibold text-gray-900">Citation search</h1>
                <p className="text-sm text-gray-500 mt-1">
                  A query is a citation event of the evaluation set ({(testMeta?.n_queries || 1975).toLocaleString()} IDCite
                  citation events): the full title of its citing paper, its full citation context and its citation
                  intent. Pick an example, or start typing a title and choose a suggestion; the event's
                  fixed set of {total} same-field candidate papers is then ranked.
                </p>
              </div>

              {metaError && <p className="text-sm text-red-600">{metaError}</p>}
              {testMeta && !testMeta.available && (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  The evaluation set is not installed on the server. {testMeta.error}
                </p>
              )}

              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold text-gray-900 mb-2">Query</legend>
                <ExampleChips examples={examples} meta={meta} active={event} onChoose={chooseEvent} />
                <div>
                  <label htmlFor="cs-title" className="block text-sm text-gray-800 mb-1.5">Title <span className="text-gray-400">(full citing paper title)</span></label>
                  <TitleAutocomplete value={titleQ} onChange={setTitleQ} onPick={chooseEvent}
                    intent={intent} field={field} meta={meta} />
                </div>
                <div>
                  <label htmlFor="cs-context" className="block text-sm text-gray-800 mb-1.5">Citation context <span className="text-gray-400">(full citing sentence)</span></label>
                  <textarea id="cs-context" value={contextQ} onChange={e => setContextQ(e.target.value)} rows={3}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit() } }}
                    placeholder="This result is similar to the rejuvenation of adult muscle stem cells, …"
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm leading-relaxed resize-y" />
                </div>
                <div>
                  <label htmlFor="cs-intent" className="block text-sm text-gray-800 mb-1.5">Citation intent</label>
                  <select id="cs-intent" value={intent} onChange={e => setIntent(e.target.value)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white">
                    <option value="">All intents</option>
                    {(meta?.intents || []).map(i => (
                      <option key={i.id} value={i.id}>{i.label} — {testMeta?.intents?.[i.id] ?? 0} events</option>
                    ))}
                  </select>
                </div>
              </fieldset>

              <div>
                <label htmlFor="cs-field" className="block text-sm text-gray-800 mb-1.5">Field <span className="text-gray-400">(of the cited paper and its candidates)</span></label>
                <select id="cs-field" value={field} onChange={e => setField(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white">
                  <option value="">All fields</option>
                  {(testMeta?.fields || []).map(f => <option key={f.name} value={f.name}>{f.name} — {f.count} events</option>)}
                </select>
              </div>

              {searchMsg && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">{searchMsg}</p>}

              <div className="flex items-center justify-end gap-5 border-t border-gray-100 pt-5">
                <button type="button" onClick={backToExample} className="text-xs text-gray-500 hover:text-gray-800 hover:underline">Back to example</button>
                <button type="button" onClick={clear} className="text-xs text-gray-500 hover:text-gray-800 hover:underline">Clear</button>
                <button type="submit" disabled={!canSearch}
                  title={canSearch ? undefined : 'Enter the full title and full citation context, or pick an example or a title suggestion'}
                  className="bg-brand-900 hover:bg-brand-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-xs font-semibold uppercase tracking-wider px-10 py-3 rounded-sm">
                  Search
                </button>
              </div>
            </form>
            {/* ── Ranking of the selected citation event (where the event list used to be) ── */}
            <div id="cs-results" className="scroll-mt-4">
              {run.loading && (
                <div className="flex items-center gap-3 text-sm text-gray-500">
                  <div className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                  Ranking {total} candidates…
                </div>
              )}
              {run.error && <p className="text-sm text-red-600">{run.error}</p>}
              {!event && !run.loading && (
                <p className="text-sm text-gray-400">Press Search to rank the candidates of this query, or pick an example or a title suggestion.</p>
              )}

              {data && !run.loading && (
                <div className="space-y-5">
                  {String(data.query.idx) === EXAMPLE_EVENT && (
                    <p className="text-xs text-gray-600 bg-white border border-gray-200 rounded px-3 py-2">
                      <span className="font-semibold">Example:</span> the query is the citing-paper title, citation context and{' '}
                      <span className="font-semibold text-blue-600">{meta?.intents?.find(i => i.id === data.query.intent)?.label || data.query.intent}</span> intent
                      of one citation event in the <span className="font-semibold text-green-700">{data.query.field}</span> field. The paper it cites ranks
                      #{data.cited.ranks.C1} with the citing title alone (C1) and #{data.cited.ranks.C2} once the citation context is added (C2).
                      Choose another event above to rank its candidates.
                    </p>
                  )}
                  {/* query */}
                  <section className="bg-white border border-gray-200 rounded-lg p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <h2 className="text-sm font-semibold text-gray-900">Query</h2>
                      <span className="text-[11px] text-gray-400">{data.query.field}</span>
                    </div>
                    <p className="text-xs uppercase tracking-wide text-gray-400">Citing Paper Title</p>
                    <p className="font-semibold text-gray-900 leading-snug">{data.query.title}</p>
                    <p className="text-xs uppercase tracking-wide text-gray-400 mt-3">Citing Citation Context</p>
                    <p className="text-[13px] text-gray-700 leading-relaxed">{data.query.context}</p>
                    <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-1">Citation intent</p>
                    <IntentBadge intent={data.query.intent} meta={meta} />
                  </section>

                  {/* cited paper ranks */}
                  <section className="bg-white border border-gray-200 rounded-lg p-5">
                    <p className="text-xs uppercase tracking-wide text-gray-400">Paper cited in this citation event</p>
                    <Link href={`/papers/${encodeURIComponent(data.cited.seed_paper_id)}`} className="font-semibold text-gray-900 hover:text-brand-700">
                      {data.cited.title}
                    </Link>
                    <p className="text-xs text-gray-500 mt-0.5 mb-3">{[data.cited.author, data.cited.journal, data.cited.year].filter(Boolean).join(' · ')}</p>
                    <p className="text-xs text-gray-600 mb-1.5">Rank among the {data.candidates} candidates, computed now:</p>
                    <RankTriple ranks={data.cited.ranks} active={condition} total={data.candidates} />
                    <button onClick={() => setShowEvidence(v => !v)} className="mt-3 block text-xs text-brand-700 hover:underline">
                      {showEvidence ? 'Hide evidence' : 'Show evidence'}
                    </button>
                    {showEvidence && (
                      <div className="mt-2 border-l-2 border-gray-200 pl-3 space-y-1.5 text-xs text-gray-600">
                        <p>IDCite citation event that records this citation (citing paper → cited paper):</p>
                        <p className="font-mono break-all text-gray-700">{data.query.citation_event_id}</p>
                        <p>
                          <a href={csvHref} className="text-brand-700 hover:underline">Download all {data.candidates} candidates as CSV</a>
                          {' · '}
                          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">How the evaluation set is generated</a>
                        </p>
                      </div>
                    )}
                  </section>

                  {/* top 10 */}
                  <section>
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                      <div className="flex flex-wrap gap-1" role="tablist">
                        {CONDITIONS.map(c => (
                          <button key={c.id} role="tab" aria-selected={c.id === condition}
                            onClick={() => push({ condition: c.id === 'C2' ? '' : c.id })}
                            className={clsx('text-xs px-3 py-1.5 rounded border',
                              c.id === condition ? 'bg-brand-900 border-brand-900 text-white' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50')}>
                            {c.label}
                          </button>
                        ))}
                      </div>
                      <a href={csvHref} className="text-xs font-semibold border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 rounded px-3 py-1.5">
                        Download CSV (all {data.candidates} candidates)
                      </a>
                    </div>
                    <p className="text-xs text-gray-500 mb-3">
                      Top {data.results.length} of {data.candidates} candidates by {condition}.
                    </p>
                    <ol className="space-y-3">
                      {data.results.map(r => (
                        <ResultCard key={r.seed_paper_id} r={r} meta={meta} condition={condition} intent={data.query.intent}
                          open={!!open[r.seed_paper_id]}
                          onToggle={() => setOpen(o => ({ ...o, [r.seed_paper_id]: !o[r.seed_paper_id] }))} />
                      ))}
                    </ol>
                  </section>
                </div>
              )}
            </div>
          </div>

          {/* ── Search Tips ─────────────────────────────────────── */}
          <aside className="text-sm text-gray-700 space-y-4">
            <h2 className="text-base font-semibold text-gray-900">Search Tips</h2>
            <p>
              Each citation event records one paper citing another, every sentence in which it does so,
              and the intent of that citation. Pick one to see how its candidates are ranked.
            </p>
            <div>
              <h3 className="font-semibold underline mb-1">Examples</h3>
              <p>
                The example chips in Query give one citation event per intent (hover to see its title and
                context). They were chosen because adding the citation context moves the cited paper to the
                top, so they illustrate the method and are not representative of the evaluation set.
              </p>
            </div>
            <div>
              <h3 className="font-semibold underline mb-1">Citation intents</h3>
              <ul className="space-y-1">
                {(meta?.intents || []).map(i => (
                  <li key={i.id}><span className="font-medium" style={{ color: i.color }}>{i.label}</span> — {i.description}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold underline mb-1">Data and verification</h3>
              <p>
                The evaluation set and its candidates are generated from the IDCite Parquet files with a fixed
                random seed. <span className="font-medium">Download CSV</span> gives all {total} candidates with their scores and
                ranks, so the ranking can be checked independently.
              </p>
              <a href={DOCS_URL} target="_blank" rel="noreferrer" className="inline-block mt-1 text-brand-700 hover:underline">
                How to regenerate the evaluation set →
              </a>
            </div>
            <div>
              <h3 className="font-semibold underline mb-1">Ranking conditions</h3>
              <ul className="space-y-1">
                {CONDITIONS.map(c => <li key={c.id}><span className="font-medium">{c.label}</span> — {c.help}.</li>)}
              </ul>
              <p className="mt-1">* All texts are encoded with frozen SciBERT; papers are ranked by cosine similarity.</p>
            </div>
          </aside>
        </div>
      </div>

    </Layout>
  )
}
