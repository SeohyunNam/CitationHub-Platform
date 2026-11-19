import Link from 'next/link'
import clsx from 'clsx'

const TABS = [
  { id: 'advanced', href: '/search/advanced', label: 'Advanced Search' },
  { id: 'citation', href: '/search/citation', label: 'Citation Search' },
]

/** Advanced / Citation search switcher shown above both search forms. */
export default function SearchTabs({ active }) {
  return (
    <div className="flex" role="tablist">
      {TABS.map(t => {
        const on = t.id === active
        return (
          <Link
            key={t.id}
            href={t.href}
            role="tab"
            aria-selected={on}
            className={clsx(
              'relative flex-1 sm:flex-none sm:w-64 text-center text-xs font-semibold uppercase tracking-wider py-4 border transition-colors',
              on
                ? 'bg-brand-900 border-brand-900 text-white'
                : 'bg-white border-gray-200 text-brand-900 hover:bg-gray-50'
            )}
          >
            {t.label}
            {on && (
              <span className="absolute left-1/2 -bottom-[7px] -translate-x-1/2 w-0 h-0 border-x-[7px] border-x-transparent border-t-[7px] border-t-brand-900" />
            )}
          </Link>
        )
      })}
    </div>
  )
}
