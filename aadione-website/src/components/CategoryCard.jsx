import { CATEGORY_ICONS, DefaultCategoryIcon } from '../config/categoryIcons'

/** Displays a single shopping category, styled consistently with FeatureRow/StepCard. */
export default function CategoryCard({ id, name, description, className = '' }) {
  const Icon = CATEGORY_ICONS[id] || DefaultCategoryIcon

  return (
    <div
      className={`group rounded-3xl border border-leaf-100 bg-white p-5 transition-all duration-200 hover:-translate-y-1 hover:border-leaf-300 hover:shadow-card ${className}`}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-50 text-leaf-700 transition-colors group-hover:bg-leaf-700 group-hover:text-white">
        <Icon size={22} aria-hidden="true" />
      </div>
      <h3 className="mt-4 font-display text-base font-semibold text-ink">{name}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-light/70">{description}</p>
    </div>
  )
}
