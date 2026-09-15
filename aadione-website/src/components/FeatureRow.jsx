export default function FeatureRow({ Icon, title, description, tone = 'leaf' }) {
  const tones = {
    leaf: 'bg-leaf-50 text-leaf-700',
    mango: 'bg-mango-light text-mango-dark',
  }
  return (
    <div className="flex gap-5 border-b border-leaf-100 py-7 last:border-none">
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${tones[tone]}`}
      >
        <Icon size={22} />
      </div>
      <div>
        <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-ink-light/75">{description}</p>
      </div>
    </div>
  )
}
