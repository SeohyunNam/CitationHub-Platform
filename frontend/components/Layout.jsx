import Link from 'next/link'
import { useRouter } from 'next/router'
import clsx from 'clsx'

const NAV_LINKS = [
  { href: '/',          label: 'Home' },
  { href: '/search',    label: 'Search' },
  { href: '/authors',   label: 'Authors' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/geo',       label: 'Geographic Map' },
  { href: '/network',   label: 'Citation Network' },
  { href: '/kg',        label: 'Knowledge Graph' },
  { href: '/sparql',    label: 'SPARQL' },
]

export default function Layout({ children }) {
  const { pathname } = useRouter()

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 flex items-center h-14 gap-8">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 bg-brand-700 rounded flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <span className="text-base font-bold text-gray-900 tracking-tight">CitationHub</span>
          </Link>

          <nav className="flex items-center gap-0.5">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'px-3.5 py-2 rounded-md text-sm transition-colors',
                  pathname === href || (href === '/search' && pathname.startsWith('/search'))
                    ? 'text-brand-700 font-semibold bg-brand-50'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50 font-medium'
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="bg-white border-t border-gray-200 py-8 mt-12">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-2">
            <span className="text-sm font-semibold text-gray-700">CitationHub</span>
            <span className="text-sm text-gray-400">
              Created by Seohyun Nam
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}
