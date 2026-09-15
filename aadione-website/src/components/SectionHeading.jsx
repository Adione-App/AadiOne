export default function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'left',
  className = '',
}) {
  const alignment = align === 'center' ? 'text-center items-center mx-auto' : 'text-left'
  return (
    <div className={`flex max-w-2xl flex-col gap-4 ${alignment} ${className}`}>
      {eyebrow && <span className="text-sm font-semibold text-leaf-600">{eyebrow}</span>}
      <h2 className="text-balance font-display text-3xl font-semibold text-ink sm:text-4xl">
        {title}
      </h2>
      {description && (
        <p className="text-balance text-base leading-relaxed text-ink-light/75 sm:text-lg">
          {description}
        </p>
      )}
    </div>
  )
}
