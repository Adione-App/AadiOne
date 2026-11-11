/**
 * Charts for the Financial Overview, drawn as plain SVG (like the Dashboard's
 * donut) — no charting library. Every value is a figure the API returned;
 * hovering a bar shows its exact amount (native SVG <title>).
 */

import { formatPaise } from '@shared/money';
import { compactRupees } from '@/lib/financeOverview';

export { compactRupees };

export interface Series {
  key: string;
  label: string;
  colour: string;
}

interface BarDatum {
  label: string;
  values: Record<string, number>;
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.colour }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Bars per bucket — `stacked` piles the series (parts of one total);
 * otherwise they stand side by side (separate amounts to compare).
 * Negative values (possible after refunds) are drawn from zero downwards.
 */
export function BarChart({ data, series, stacked = false, height = 220 }: { data: BarDatum[]; series: Series[]; stacked?: boolean; height?: number }) {
  if (data.length === 0) return <p className="py-10 text-center text-sm text-gray-500">No delivered orders in this period.</p>;
  const width = Math.max(320, data.length * (stacked ? 28 : 14 + series.length * 12));
  const pad = { top: 10, right: 8, bottom: 26, left: 56 };
  const plotH = height - pad.top - pad.bottom;
  const plotW = width - pad.left - pad.right;
  const totals = data.map((d) =>
    stacked
      ? { hi: series.reduce((s, x) => s + Math.max(0, d.values[x.key] ?? 0), 0), lo: series.reduce((s, x) => s + Math.min(0, d.values[x.key] ?? 0), 0) }
      : { hi: Math.max(0, ...series.map((x) => d.values[x.key] ?? 0)), lo: Math.min(0, ...series.map((x) => d.values[x.key] ?? 0)) },
  );
  const max = Math.max(1, ...totals.map((t) => t.hi));
  const min = Math.min(0, ...totals.map((t) => t.lo));
  const span = max - min;
  const y = (v: number) => pad.top + ((max - v) / span) * plotH;
  const slot = plotW / data.length;
  const ticks = [max, max / 2, 0, ...(min < 0 ? [min] : [])];
  const labelEvery = Math.max(1, Math.ceil(data.length / 12));

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full min-w-[320px]" role="img" aria-label={series.map((s) => s.label).join(', ')}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#D1D5DB' : '#F3F4F6'} />
              <text x={pad.left - 6} y={y(t) + 3} textAnchor="end" fontSize="10" className="fill-gray-500">
                {compactRupees(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = pad.left + i * slot;
            const barW = stacked ? Math.min(22, slot * 0.7) : Math.min(12, (slot * 0.8) / series.length);
            let up = 0;
            let down = 0;
            return (
              <g key={d.label + i}>
                {series.map((s, j) => {
                  const v = d.values[s.key] ?? 0;
                  if (v === 0) return null;
                  let top: number;
                  let bottom: number;
                  if (stacked) {
                    if (v > 0) {
                      top = y(up + v);
                      bottom = y(up);
                      up += v;
                    } else {
                      top = y(down);
                      bottom = y(down + v);
                      down += v;
                    }
                  } else {
                    top = y(Math.max(0, v));
                    bottom = y(Math.min(0, v));
                  }
                  const x = stacked ? x0 + (slot - barW) / 2 : x0 + (slot - barW * series.length) / 2 + j * barW;
                  return (
                    <rect key={s.key} x={x} y={top} width={barW - (stacked ? 0 : 1)} height={Math.max(0.5, bottom - top)} fill={s.colour} rx="1.5">
                      <title>{`${d.label} · ${s.label}: ${formatPaise(v)}`}</title>
                    </rect>
                  );
                })}
                {i % labelEvery === 0 && (
                  <text x={x0 + slot / 2} y={height - 8} textAnchor="middle" fontSize="10" className="fill-gray-500">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <Legend series={series} />
    </div>
  );
}

/** Share of a whole — e.g. COD vs Online. Only positive parts are drawn. */
export function DonutChart({ parts, centre }: { parts: { label: string; value: number; colour: string; detail?: string }[]; centre: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;
  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <svg viewBox="0 0 160 160" className="h-40 w-40 -rotate-90" role="img" aria-label={parts.map((p) => p.label).join(', ')}>
        <circle cx="80" cy="80" r={radius} fill="none" stroke="#F3F4F6" strokeWidth="22" />
        {total > 0 &&
          parts.map((p) => {
            const length = (Math.max(0, p.value) / total) * circumference;
            const offset = -consumed;
            consumed += length;
            return (
              <circle key={p.label} cx="80" cy="80" r={radius} fill="none" stroke={p.colour} strokeWidth="22" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={offset}>
                <title>{`${p.label}: ${formatPaise(p.value)}`}</title>
              </circle>
            );
          })}
        <g transform="rotate(90 80 80)">
          <text x="80" y="84" textAnchor="middle" fontSize="15" fontWeight="700" className="fill-gray-900">
            {centre}
          </text>
        </g>
      </svg>
      <ul className="min-w-[180px] space-y-2 text-sm">
        {parts.map((p) => (
          <li key={p.label} className="flex items-start gap-2.5">
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.colour }} />
            <span className="text-gray-700">
              {p.label}
              {p.detail && <span className="block text-xs text-gray-500">{p.detail}</span>}
            </span>
            <span className="ml-auto pl-3 text-right font-medium text-gray-900">
              {formatPaise(p.value)}
              {total > 0 && <span className="block text-xs font-normal text-gray-500">{Math.round((Math.max(0, p.value) / total) * 100)}%</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
