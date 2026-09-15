import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Menu, X, Smartphone } from 'lucide-react'
import Container from './Container'
import Button from './Button'
import { nav, appLinks } from '../config/site'

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
        scrolled ? 'border-leaf-100 bg-cream/90 backdrop-blur-md' : 'border-transparent bg-cream'
      }`}
    >
      <Container className="flex h-20 items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <img src="/assets/logo.svg" alt="Aadione" className="h-9 w-9" />
          <span className="font-display text-2xl font-semibold text-ink">Aadione</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-leaf-100 text-leaf-800'
                    : 'text-ink-light/80 hover:bg-leaf-50 hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden lg:block">
          <Button href={appLinks.playStore} variant="primary" size="md" icon={Smartphone}>
            Download App
          </Button>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center justify-center rounded-full p-2 text-ink lg:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          {open ? <X size={26} /> : <Menu size={26} />}
        </button>
      </Container>

      {open && (
        <div className="border-t border-leaf-100 bg-cream lg:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `rounded-xl px-4 py-3 text-base font-medium ${
                    isActive ? 'bg-leaf-100 text-leaf-800' : 'text-ink-light/90 hover:bg-leaf-50'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <Button href={appLinks.playStore} variant="primary" size="md" className="mt-2 w-full">
              Download App
            </Button>
          </Container>
        </div>
      )}
    </header>
  )
}
