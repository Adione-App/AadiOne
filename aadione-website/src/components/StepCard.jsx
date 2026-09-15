export default function StepCard({ number, title, description, Icon }) {
  return (
    <div className="relative flex flex-col gap-4 rounded-3xl border border-leaf-100 bg-white p-7">
      <div className="flex items-center justify-between">
        <span className="font-display text-4xl font-semibold text-leaf-200">{number}</span>
        {Icon && (
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-50 text-leaf-700">
            <Icon size={22} />
          </div>
        )}
      </div>
      <h3 className="font-display text-xl font-semibold text-ink">{title}</h3>
      <p className="text-sm leading-relaxed text-ink-light/75">{description}</p>
    </div>
  )
}
