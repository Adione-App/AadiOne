import Container from './Container'

export default function PageHero({ eyebrow, title, description }) {
  return (
    <section className="relative overflow-hidden border-b border-leaf-100 bg-gradient-to-b from-leaf-50 to-white pb-14 pt-14 sm:pb-20 sm:pt-20">
      <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-32 h-80 w-80 rounded-full bg-leaf-100/70 blur-3xl" />
      <Container className="relative">
        {eyebrow && <span className="text-sm font-semibold text-leaf-600">{eyebrow}</span>}
        <h1 className="mt-3 max-w-2xl text-balance font-display text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">{title}</h1>
        {description && (
          <p className="mt-5 max-w-xl text-balance text-base leading-relaxed text-ink-light/80 sm:text-lg">{description}</p>
        )}
      </Container>
    </section>
  )
}
