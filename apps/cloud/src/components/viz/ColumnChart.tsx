"use client";

// ADR 0032 §3 B3, panel 1 — "column chart, one series → one color... Columns
// ≤24px thick, 4px rounded cap at the data end, square at the baseline, 2px
// surface-color gap between adjacent columns. Direct-label only the maximum
// column's value on its cap; the axis carries the rest." Hand-rolled inline
// SVG per CLAUDE.md ("no component library — keep it that way") and the
// dataviz skill's marks-and-anatomy spec.
import { useState } from "react";
import { SERIES_1, VIZ_BORDER_STRONG, VIZ_GRIDLINE_SOFT, VIZ_INK_2 } from "./palette";

export interface ColumnDatum {
  date: string;
  value: number;
}

export interface ColumnChartProps {
  data: ColumnDatum[];
  formatValue: (n: number) => string;
  formatDate: (isoDay: string) => string;
  height?: number;
  ariaLabel: string;
}

const MAX_BAR_WIDTH = 24;
const GAP = 2;
const CHART_WIDTH = 720;

function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const niceNorm = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return niceNorm * pow;
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const step = niceStep(max / 3) || 1;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(Math.round(v * 1_000_000) / 1_000_000);
  return ticks.length > 1 ? ticks : [0, max];
}

/** Small-multiples column chart: daily cost or daily session counts, per
 * ADR 0032 §3 B6's "sessions-count series" fallback when nothing is priced. */
export function ColumnChart({ data, formatValue, formatDate, height = 160, ariaLabel }: ColumnChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const axisBand = 22;
  const plotHeight = height - axisBand;
  const topPad = 16;

  const maxValue = data.reduce((m, d) => Math.max(m, d.value), 0);
  const maxIndex = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -Infinity) ? i : best), 0);
  const ticks = niceTicks(maxValue);
  const scaleMax = ticks[ticks.length - 1] || 1;

  const slot = data.length > 0 ? CHART_WIDTH / data.length : CHART_WIDTH;
  const barWidth = Math.max(2, Math.min(MAX_BAR_WIDTH, slot - GAP));
  const xTickEvery = Math.max(1, Math.round(data.length / 8 / 7) * 7) || 7;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${CHART_WIDTH} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
        {ticks.map((t) => {
          const y = plotHeight - (t / scaleMax) * (plotHeight - topPad);
          return (
            <g key={t}>
              <line x1={0} x2={CHART_WIDTH} y1={y} y2={y} stroke={VIZ_GRIDLINE_SOFT} strokeWidth={1} />
              <text x={0} y={Math.max(y - 3, 9)} fontSize={10} fill={VIZ_INK_2} className="tabular-nums">
                {formatValue(t)}
              </text>
            </g>
          );
        })}
        <line x1={0} x2={CHART_WIDTH} y1={plotHeight} y2={plotHeight} stroke={VIZ_BORDER_STRONG} strokeWidth={1} />
        {data.map((d, i) => {
          const barHeight = scaleMax > 0 ? (d.value / scaleMax) * (plotHeight - topPad) : 0;
          const x = i * slot + (slot - barWidth) / 2;
          const y = plotHeight - barHeight;
          const isMax = i === maxIndex && d.value > 0;
          return (
            <g key={d.date}>
              {/* Wider invisible hit target so short bars still clear the 24px hover/focus minimum. */}
              <rect
                x={i * slot}
                y={0}
                width={slot}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                aria-label={`${formatDate(d.date)}: ${formatValue(d.value)}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                <title>{`${formatDate(d.date)}: ${formatValue(d.value)}`}</title>
              </rect>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 0)}
                rx={4}
                fill={SERIES_1}
                pointerEvents="none"
                opacity={active === null || active === i ? 1 : 0.55}
              />
              {isMax && (
                <text x={x + barWidth / 2} y={Math.max(y - 6, 9)} fontSize={10} fill={VIZ_INK_2} textAnchor="middle">
                  {formatValue(d.value)}
                </text>
              )}
              {i % xTickEvery === 0 && (
                <text x={x + barWidth / 2} y={height - 4} fontSize={10} fill={VIZ_INK_2} textAnchor="middle">
                  {formatDate(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {active !== null && data[active] && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-xs border border-line bg-surface px-2 py-1 text-micro tabular-nums text-ink shadow-sm"
          style={{ left: `${((active + 0.5) / Math.max(data.length, 1)) * 100}%` }}
        >
          <div className="text-ink-2">{formatDate(data[active].date)}</div>
          <div className="font-medium tabular-nums">{formatValue(data[active].value)}</div>
        </div>
      )}
    </div>
  );
}
