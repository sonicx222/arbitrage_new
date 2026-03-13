/**
 * Lightweight SVG Chart Component
 *
 * P0-1 FIX: Replaces Recharts (528 KB / 78% of bundle) with a ~4 KB custom component.
 * Supports line and area charts with axes, grid, and hover tooltip.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { CHART } from '../lib/theme';

interface ChartProps<T> {
  data: T[];
  dataKey: string & keyof T;
  xKey?: string;
  height?: number;
  color?: string;
  fill?: boolean;
  yDomain?: [number, number];
  ariaLabel?: string;
  formatValue?: (v: number) => string;
}

const MARGIN = { top: 8, right: 12, bottom: 24, left: 44 };

export function Chart<T>({
  data,
  dataKey,
  xKey = 'time',
  height = 180,
  color = '#d4a574',
  fill = false,
  yDomain,
  ariaLabel,
  formatValue,
}: ChartProps<T>) {
  const val = (d: T, key: string) => (d as Record<string, unknown>)[key];
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const chartW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const chartH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  // Extract numeric values
  const values: number[] = [];
  for (const d of data) {
    const v = val(d, dataKey);
    values.push(typeof v === 'number' && Number.isFinite(v) ? v : 0);
  }

  // Y scale
  let yMin: number, yMax: number;
  if (yDomain) {
    yMin = yDomain[0];
    yMax = yDomain[1];
  } else if (values.length === 0) {
    yMin = 0;
    yMax = 1;
  } else {
    yMin = Math.min(0, ...values);
    yMax = Math.max(...values);
  }
  if (yMax <= yMin) yMax = yMin + 1;
  const yRange = yMax - yMin;

  const toX = (i: number) =>
    MARGIN.left + (data.length <= 1 ? chartW / 2 : (i / (data.length - 1)) * chartW);
  const toY = (v: number) =>
    MARGIN.top + chartH - ((v - yMin) / yRange) * chartH;

  // Build SVG path
  let linePath = '';
  if (data.length > 0 && chartW > 0) {
    linePath = `M${toX(0).toFixed(1)},${toY(values[0]).toFixed(1)}`;
    for (let i = 1; i < data.length; i++) {
      linePath += `L${toX(i).toFixed(1)},${toY(values[i]).toFixed(1)}`;
    }
  }

  let areaPath = '';
  if (fill && linePath) {
    const baseline = toY(yMin);
    areaPath = `${linePath}L${toX(data.length - 1).toFixed(1)},${baseline.toFixed(1)}L${toX(0).toFixed(1)},${baseline.toFixed(1)}Z`;
  }

  // Y axis ticks
  const TICK_COUNT = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= TICK_COUNT; i++) {
    yTicks.push(yMin + (yRange * i) / TICK_COUNT);
  }

  // X axis labels (~6 evenly spaced)
  const xCount = Math.min(6, data.length);
  const xLabels: { x: number; label: string }[] = [];
  if (data.length > 1 && xCount > 1) {
    for (let i = 0; i < xCount; i++) {
      const idx = Math.round((i / (xCount - 1)) * (data.length - 1));
      xLabels.push({ x: toX(idx), label: String(val(data[idx], xKey) ?? '') });
    }
  }

  // Format helpers
  const fmtY = (v: number): string => {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(1);
  };
  const fmtVal = formatValue ?? fmtY;

  // Mouse interaction
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (data.length === 0 || chartW <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left - MARGIN.left;
      setHoverIdx(Math.max(0, Math.min(data.length - 1, Math.round((x / chartW) * (data.length - 1)))));
    },
    [data.length, chartW],
  );
  const handleMouseLeave = useCallback(() => setHoverIdx(null), []);

  // Hover indicator data
  const hoverPoint =
    hoverIdx !== null && data[hoverIdx]
      ? {
          x: toX(hoverIdx),
          y: toY(values[hoverIdx]),
          value: values[hoverIdx],
          label: String(val(data[hoverIdx], xKey) ?? ''),
        }
      : null;

  // Tooltip position (flip near right edge)
  const TIP_W = 100;
  const tipLeft = hoverPoint
    ? hoverPoint.x + 12 + TIP_W > width
      ? hoverPoint.x - TIP_W - 4
      : hoverPoint.x + 12
    : 0;
  const tipTop = hoverPoint ? Math.max(4, Math.min(hoverPoint.y - 14, height - 28)) : 0;

  // Waiting for width measurement
  if (width === 0) return <div ref={containerRef} style={{ width: '100%', height }} />;

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height, position: 'relative' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      role="img"
      aria-label={ariaLabel}
    >
      <svg width={width} height={height} className="select-none">
        {/* Grid lines */}
        {yTicks.map((t, i) => (
          <line
            key={i}
            x1={MARGIN.left}
            y1={toY(t)}
            x2={width - MARGIN.right}
            y2={toY(t)}
            stroke={CHART.grid}
            strokeDasharray="3 3"
          />
        ))}
        {/* Area fill */}
        {areaPath && <path d={areaPath} fill={color} fillOpacity={0.1} />}
        {/* Line */}
        {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />}
        {/* Single data point dot */}
        {data.length === 1 && <circle cx={toX(0)} cy={toY(values[0])} r={3} fill={color} />}
        {/* Y axis labels */}
        {yTicks.map((t, i) => (
          <text
            key={i}
            x={MARGIN.left - 6}
            y={toY(t)}
            textAnchor="end"
            dominantBaseline="middle"
            fill={CHART.tick}
            fontSize={9}
            fontFamily="var(--font-mono), monospace"
          >
            {fmtY(t)}
          </text>
        ))}
        {/* X axis labels */}
        {xLabels.map(({ x, label }, i) => (
          <text
            key={i}
            x={x}
            y={height - 4}
            textAnchor="middle"
            fill={CHART.tick}
            fontSize={9}
            fontFamily="var(--font-mono), monospace"
          >
            {label}
          </text>
        ))}
        {/* Hover crosshair + dot */}
        {hoverPoint && (
          <>
            <line
              x1={hoverPoint.x}
              y1={MARGIN.top}
              x2={hoverPoint.x}
              y2={MARGIN.top + chartH}
              stroke={CHART.crosshair}
              strokeDasharray="2 2"
            />
            <circle cx={hoverPoint.x} cy={hoverPoint.y} r={3.5} fill={color} stroke={CHART.dotStroke} strokeWidth={1.5} />
          </>
        )}
      </svg>
      {/* HTML tooltip for better text rendering */}
      {hoverPoint && (
        <div
          className="absolute pointer-events-none z-10 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] whitespace-nowrap"
          style={{ left: tipLeft, top: tipTop }}
        >
          <span className="text-gray-400">{hoverPoint.label}</span>{' '}
          <span className="font-mono text-gray-100">{fmtVal(hoverPoint.value)}</span>
        </div>
      )}
    </div>
  );
}
