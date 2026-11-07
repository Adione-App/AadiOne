import Container from '../components/Container'
import Button from '../components/Button'
import useSEO from '../lib/useSEO'
import { PageError, PageMeta, PageSections, PageSkeleton } from '../components/InfoPageDocument'
import { useInfoPage } from '../lib/publicApi'

// The published "About Aadione" page from the Aadione API — the same text as
// the app's About screen. Nothing about the business is written here.
export default function About() {
  useSEO({
    title: 'About',
    description: 'Aadione is a hyperlocal marketplace that brings the shops and restaurants of your town into one app.',
    path: '/about',
  })
  const { status, data: page, retry } = useInfoPage('about')

  return (
    <>
      <section className="border-b border-leaf-100 bg-leaf-50/60 py-14 sm:py-20">
        <Container>
          <span className="text-sm font-semibold text-leaf-600">About</span>
          <h1 className="mt-3 max-w-2xl text-balance font-display text-3xl font-semibold text-ink sm:text-4xl">
            {page?.title || 'About Aadione'}
          </h1>
          {page && <PageMeta page={page} />}
        </Container>
      </section>

      <section className="bg-white py-12 sm:py-16">
        <Container>
          <article className="prose-legal mx-auto min-w-0 max-w-3xl break-words">
            {status === 'loading' && <PageSkeleton />}
            {status === 'error' && <PageError slug="about" onRetry={retry} />}
            {status === 'ready' && page && <PageSections page={page} />}
            {status === 'ready' && !page && (
              <p>Aadione is a hyperlocal marketplace that brings the shops, restaurants and other local businesses around you into one app.</p>
            )}
          </article>
          <div className="mx-auto mt-10 max-w-3xl">
            <Button to="/how-it-works" variant="primary">
              See how ordering works
            </Button>
          </div>
        </Container>
      </section>
    </>
  )
}
