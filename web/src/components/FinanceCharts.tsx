/**
 * Charts for the Financial Overview, drawn as plain SVG (like the Dashboard's
 * donut) — no charting library. Every value is a figure the API returned;
 * hovering a bar shows its exact amount (native SVG <title>).
 *
 * Sizes are REAL pixels: a bar chart measures its container and draws at
 * exactly that width and a fixed height (CHART_HEIGHT), so bar widths, gaps
 * and the 11 px axis labels stay the same on every screen — the SVG is never
 * stretched to fill the card.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { formatPaise } from '@shared/money';
import { AXIS_FONT_PX, barGeometry, chartHeight, compactRupees, labelStride, niceTicks } from '@/lib/financeOverview';

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

/** The element's current content width in px (0 until first measured). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
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
export function BarChart({ data, series, stacked = false }: { data: BarDatum[]; series: Series[]; stacked?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = chartHeight(width || 1024);

  let body: React.ReactNode = null;
  if (data.length === 0) {
    body = <p className="flex h-full items-center justify-center text-sm text-gray-500">No delivered orders in this period.</p>;
  } else if (width > 0) {
    const pad = { top: 8, right: 4, bottom: 22, left: 48 };
    const plotW = Math.max(40, width - pad.left - pad.right);
    const plotH = height - pad.top - pad.bottom;
    const extent = data.map((d) =>
      stacked
        ? { hi: series.reduce((s, x) => s + Math.max(0, d.values[x.key] ?? 0), 0), lo: series.reduce((s, x) => s + Math.min(0, d.values[x.key] ?? 0), 0) }
        : { hi: Math.max(0, ...series.map((x) => d.values[x.key] ?? 0)), lo: Math.min(0, ...series.map((x) => d.values[x.key] ?? 0)) },
    );
    const { ticks, top, bottom } = niceTicks(Math.min(...extent.map((e) => e.lo)), Math.max(...extent.map((e) => e.hi)));
    const y = (v: number) => pad.top + ((top - v) / (top - bottom)) * plotH;
    const geo = barGeometry(data.length, plotW, series.length, stacked);
    const stride = labelStride(data.length, plotW);

    body = (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img" aria-label={series.map((s) => s.label).join(', ')}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#D1D5DB' : '#F3F4F6'} />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize={AXIS_FONT_PX} className="fill-gray-500">
              {compactRupees(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const centre = pad.left + i * geo.slot + geo.slot / 2;
          const left = centre - geo.group / 2;
          let up = 0;
          let down = 0;
          return (
            <g key={d.label + i}>
              {series.map((s, j) => {
                const v = d.values[s.key] ?? 0;
                if (v === 0) return null;
                let y0: number;
                let y1: number;
                if (stacked) {
                  if (v > 0) {
                    y0 = y(up + v);
                    y1 = y(up);
                    up += v;
                  } else {
                    y0 = y(down);
                    y1 = y(down + v);
                    down += v;
                  }
                } else {
                  y0 = y(Math.max(0, v));
                  y1 = y(Math.min(0, v));
                }
                const x = stacked ? left : left + j * (geo.bar + geo.gap);
                return (
                  <rect key={s.key} x={x} y={y0} width={geo.bar} height={Math.max(1, y1 - y0)} fill={s.colour} rx="2">
                    <title>{`${d.label} · ${s.label}: ${formatPaise(v)}`}</title>
                  </rect>
                );
              })}
              {i % stride === 0 && (
                // Kept inside the canvas: a label near either edge is anchored to that edge instead of centred.
                <text
                  x={centre + 26 > width ? width - 1 : centre - 26 < 0 ? 1 : centre}
                  y={height - 6}
                  textAnchor={centre + 26 > width ? 'end' : centre - 26 < 0 ? 'start' : 'middle'}
                  fontSize={AXIS_FONT_PX}
                  className="fill-gray-500"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <div className="min-w-0">
      {/* Fixed height, measured width: never stretched, never wider than the card. */}
      <div ref={ref} className="w-full overflow-hidden" style={{ height }}>
        {body}
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
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
      <svg viewBox="0 0 160 160" width="136" height="136" className="shrink-0 -rotate-90" role="img" aria-label={parts.map((p) => p.label).join(', ')}>
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
          <text x="80" y="85" textAnchor="middle" fontSize="15" fontWeight="700" className="fill-gray-900">
            {centre}
          </text>
        </g>
      </svg>
      <ul className="min-w-[180px] flex-1 space-y-1.5 text-sm">
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
