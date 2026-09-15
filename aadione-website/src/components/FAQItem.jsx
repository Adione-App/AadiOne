import { useState } from 'react'
import { Plus } from 'lucide-react'

export default function FAQItem({ question, answer, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-b border-leaf-100 py-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
      >
        <span className="font-display text-lg font-medium text-ink">{question}</span>
        <Plus
          size={20}
          className={`shrink-0 text-leaf-600 transition-transform duration-300 ${
            open ? 'rotate-45' : ''
          }`}
        />
      </button>
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <p className="pt-3 pr-8 text-sm leading-relaxed text-ink-light/75">{answer}</p>
        </div>
      </div>
    </div>
  )
}
