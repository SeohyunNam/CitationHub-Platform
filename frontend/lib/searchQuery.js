/** Query keys shared by the advanced search form and /search results. */
export const SEARCH_KEYS = [
  'q', 'title', 'author', 'journal', 'field', 'country', 'year_min', 'year_max',
]

export function qstr(value) {
  if (Array.isArray(value)) return value[0] || ''
  return value || ''
}

/** Keep only filled search fields from a Next.js router.query or a form object. */
export function pickSearchQuery(src) {
  const out = {}
  for (const key of SEARCH_KEYS) {
    const s = qstr(src[key]).trim()
    if (s) out[key] = s
  }
  return out
}

export function searchParamsFrom(src, extra = {}) {
  const params = new URLSearchParams()
  const merged = { ...pickSearchQuery(src), ...extra }
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== null && String(value) !== '') {
      params.set(key, String(value))
    }
  }
  return params
}

export const ADVANCED_FIELDS = ['title', 'author', 'journal', 'year_min', 'year_max']

export function hasAdvancedFilters(src) {
  return ADVANCED_FIELDS.some(key => qstr(src[key]).trim())
}
