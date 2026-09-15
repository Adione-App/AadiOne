export default function Stat({ value, label }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-leaf-500 pl-4">
      <span className="font-display text-3xl font-semibold text-ink sm:text-4xl">{value}</span>
      <span className="text-sm text-ink-light/70">{label}</span>
    </div>
  )
}
