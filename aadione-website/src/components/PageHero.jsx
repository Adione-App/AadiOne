import Container from './Container'

export default function PageHero({ eyebrow, title, description }) {
  return (
    <section className="relative overflow-hidden bg-leaf-900 pb-20 pt-28 text-cream-100 sm:pt-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-blob bg-leaf-700/40 blur-2xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-16 bottom-0 h-56 w-56 rounded-blob bg-mango/20 blur-3xl"
      />
      <Container className="relative">
        {eyebrow && (
          <span className="text-sm font-semibold text-leaf-300">{eyebrow}</span>
        )}
        <h1 className="mt-3 max-w-2xl text-balance font-display text-4xl font-semibold text-white sm:text-5xl">
          {title}
        </h1>
        {description && (
          <p className="mt-5 max-w-xl text-balance text-base leading-relaxed text-cream-100/75 sm:text-lg">
            {description}
          </p>
        )}
      </Container>
    </section>
  )
}
