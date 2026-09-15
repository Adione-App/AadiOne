import { Home } from 'lucide-react'
import Container from '../components/Container'
import Button from '../components/Button'
import useSEO from '../lib/useSEO'

export default function NotFound() {
  useSEO({
    title: 'Page not found',
    description: 'The page you are looking for could not be found.',
    path: '/404',
  })

  return (
    <section className="flex min-h-[70vh] items-center bg-cream py-24">
      <Container className="flex flex-col items-center text-center">
        <span className="font-display text-7xl font-semibold text-leaf-200">404</span>
        <h1 className="mt-4 font-display text-2xl font-semibold text-ink sm:text-3xl">
          This page wandered off the shelf.
        </h1>
        <p className="mt-3 max-w-md text-ink-light/70">
          The page you're looking for doesn't exist or may have moved. Let's get you back home.
        </p>
        <Button to="/" variant="primary" icon={Home} className="mt-8">
          Back to home
        </Button>
      </Container>
    </section>
  )
}
