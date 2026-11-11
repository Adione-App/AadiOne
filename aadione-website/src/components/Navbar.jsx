import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import Container from './Container'
import Logo from './Logo'
import AppStoreButtons, { DownloadAppButton } from './AppStoreButtons'
import { nav } from '../config/site'

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const location = useLocation()

  useEffect(() => setOpen(false), [location.pathname])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-colors ${
        scrolled || open ? 'border-leaf-100 bg-white/90 backdrop-blur-md' : 'border-transparent bg-white'
      }`}
    >
      <Container className="flex h-[72px] items-center justify-between gap-4">
        <Link to="/" className="flex shrink-0 items-center" aria-label="Aadione home">
          <Logo className="h-9 sm:h-10" />
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
                  isActive ? 'bg-leaf-50 text-leaf-800' : 'text-ink-light/80 hover:bg-leaf-50 hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <DownloadAppButton className="px-4 sm:px-5" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center justify-center rounded-full p-2 text-ink hover:bg-leaf-50 lg:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobile-menu"
          >
            {open ? <X size={26} /> : <Menu size={26} />}
          </button>
        </div>
      </Container>

      {open && (
        <div id="mobile-menu" className="border-t border-leaf-100 bg-white lg:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `rounded-xl px-4 py-3 text-base font-semibold ${isActive ? 'bg-leaf-50 text-leaf-800' : 'text-ink-light/90 hover:bg-leaf-50'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <div className="mt-3 border-t border-leaf-100 px-4 pt-4">
              <p className="mb-3 text-sm font-semibold text-ink">Get the app</p>
              <AppStoreButtons />
            </div>
          </Container>
        </div>
      )}
    </header>
  )
}
