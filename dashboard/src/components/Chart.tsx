/**
 * Lightweight SVG Chart Component
 *
 * P0-1 FIX: Replaces Recharts (528 KB / 78% of bundle) with a ~4 KB custom component.
 * Supports line and area charts with axes, grid, and hover tooltip.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { CHART } from '../lib/theme';
import { createPortal } from 'react-dom';

interface ChartProps<T> {
  data: T[];
  dataKey: string & keyof T;
  xKey?: string;
  height?: number;
  color?: string;
  fill?: boolean;
  dashed?: boolean;
  yDomain?: [number, number];
  ariaLabel?: string;
  formatValue?: (v: number) => string;
}

// Zoom constants
const MIN_ZOOM_POINTS = 10; // Minimum visible data points when zoomed in
const ZOOM_FACTOR = 0.15;   // Fraction of range to zoom per wheel tick

const MARGIN = { top: 8, right: 12, bottom: 24, left: 44 };

export function Chart<T>({
  data,
  dataKey,
  xKey = 'time',
  height = 180,
  color = '#d4a574',
  fill = false,
  dashed = false,
  yDomain,
  ariaLabel,
  formatValue,
}: ChartProps<T>) {
  const val = (d: T, key: string) => (d as Record<string, unknown>)[key];
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Zoom state: visible range as indices into data array
  const [zoomStart, setZoomStart] = useState(0);
  const [zoomEnd, setZoomEnd] = useState(0);
  const isZoomed = data.length > 0 && (zoomStart > 0 || zoomEnd < data.length);

  // Reset zoom when data length changes significantly (new data stream)
  useEffect(() => {
    setZoomStart(0);
    setZoomEnd(data.length);
  }, [data.length]);

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

  const effectiveHeight = fullscreen ? window.innerHeight - 48 : height;
  const chartW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const chartH = Math.max(effectiveHeight - MARGIN.top - MARGIN.bottom, 0);

  // Zoom: slice visible data
  const visStart = Math.max(0, Math.min(zoomStart, data.length));
  const visEnd = Math.max(visStart, Math.min(zoomEnd, data.length));
  const visData = data.slice(visStart, visEnd);

  // Extract numeric values from visible data
  const values: number[] = [];
  for (const d of visData) {
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
    yMin = 0;
    yMax = values[0];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (yMax <= yMin) yMax = yMin + 1;
  const yRange = yMax - yMin;

  const toX = (i: number) =>
    MARGIN.left + (visData.length <= 1 ? chartW / 2 : (i / (visData.length - 1)) * chartW);
  const toY = (v: number) =>
    MARGIN.top + chartH - ((v - yMin) / yRange) * chartH;

  // Build SVG path (array-join for single allocation)
  let linePath = '';
  if (visData.length > 0 && chartW > 0) {
    const parts = new Array<string>(visData.length);
    parts[0] = `M${toX(0).toFixed(1)},${toY(values[0]).toFixed(1)}`;
    for (let i = 1; i < visData.length; i++) {
      parts[i] = `L${toX(i).toFixed(1)},${toY(values[i]).toFixed(1)}`;
    }
    linePath = parts.join('');
  }

  let areaPath = '';
  if (fill && linePath) {
    const baseline = toY(yMin);
    areaPath = `${linePath}L${toX(visData.length - 1).toFixed(1)},${baseline.toFixed(1)}L${toX(0).toFixed(1)},${baseline.toFixed(1)}Z`;
  }

  // Y axis ticks
  const TICK_COUNT = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= TICK_COUNT; i++) {
    yTicks.push(yMin + (yRange * i) / TICK_COUNT);
  }

  // X axis labels (~6 evenly spaced)
  const xCount = Math.min(6, visData.length);
  const xLabels: { x: number; label: string }[] = [];
  if (visData.length > 1 && xCount > 1) {
    for (let i = 0; i < xCount; i++) {
      const idx = Math.round((i / (xCount - 1)) * (visData.length - 1));
      xLabels.push({ x: toX(idx), label: String(val(visData[idx], xKey) ?? '') });
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
      if (visData.length === 0 || chartW <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left - MARGIN.left;
      setHoverIdx(Math.max(0, Math.min(visData.length - 1, Math.round((x / chartW) * (visData.length - 1)))));
    },
    [visData.length, chartW],
  );
  const handleMouseLeave = useCallback(() => setHoverIdx(null), []);

  // Mouse wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (data.length <= MIN_ZOOM_POINTS) return;
      e.preventDefault();

      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - MARGIN.left;
      const curRange = visEnd - visStart;
      // Fraction of visible range where the mouse is (0..1)
      const anchor = chartW > 0 ? Math.max(0, Math.min(1, mouseX / chartW)) : 0.5;

      const delta = e.deltaY > 0 ? ZOOM_FACTOR : -ZOOM_FACTOR; // positive = zoom out
      const newRange = Math.max(MIN_ZOOM_POINTS, Math.min(data.length, Math.round(curRange * (1 + delta))));

      // Keep the anchor point stable
      let newStart = Math.round(visStart + (curRange - newRange) * anchor);
      newStart = Math.max(0, Math.min(data.length - newRange, newStart));
      setZoomStart(newStart);
      setZoomEnd(newStart + newRange);
    },
    [data.length, visStart, visEnd, chartW],
  );

  const resetZoom = useCallback(() => {
    setZoomStart(0);
    setZoomEnd(data.length);
  }, [data.length]);

  // Hover indicator data
  const hoverPoint =
    hoverIdx !== null && visData[hoverIdx]
      ? {
          x: toX(hoverIdx),
          y: toY(values[hoverIdx]),
          value: values[hoverIdx],
          label: String(val(visData[hoverIdx], xKey) ?? ''),
        }
      : null;

  // Tooltip position (flip near right edge)
  const TIP_W = 100;
  const tipLeft = hoverPoint
    ? hoverPoint.x + 12 + TIP_W > width
      ? hoverPoint.x - TIP_W - 4
      : hoverPoint.x + 12
    : 0;
  const tipTop = hoverPoint ? Math.max(4, Math.min(hoverPoint.y - 14, effectiveHeight - 28)) : 0;

  // D-1: Escape key closes fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Waiting for width measurement
  if (width === 0) return <div ref={containerRef} style={{ width: '100%', height }} />;

  const chart = (
    <div
      ref={fullscreen ? undefined : containerRef}
      style={{ width: '100%', height: effectiveHeight, position: 'relative' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onWheel={handleWheel}
      role="img"
      aria-label={ariaLabel}
    >
      <svg width={width} height={effectiveHeight} className="select-none">
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
        {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dashed ? '6 3' : undefined} />}
        {/* Single data point dot */}
        {visData.length === 1 && <circle cx={toX(0)} cy={toY(values[0])} r={3} fill={color} />}
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
            y={effectiveHeight - 4}
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
      {/* Chart controls (top-right) */}
      <div className="absolute top-1 right-1 flex gap-1">
        {isZoomed && (
          <button
            onClick={resetZoom}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-800/80 text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors"
            aria-label="Reset chart zoom"
          >
            Reset zoom
          </button>
        )}
        <button
          onClick={() => setFullscreen((f) => !f)}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-800/80 text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors"
          aria-label={fullscreen ? 'Exit fullscreen chart' : 'Fullscreen chart'}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
        >
          {fullscreen ? '\u2716' : '\u26F6'}
        </button>
      </div>
    </div>
  );

  if (fullscreen) {
    return createPortal(
      <div
        ref={containerRef}
        className="fixed inset-0 z-50 bg-surface flex flex-col"
        style={{ padding: '24px 16px 16px' }}
      >
        {ariaLabel && <div className="text-xs text-gray-500 mb-1 px-1">{ariaLabel}</div>}
        {chart}
      </div>,
      document.body,
    );
  }

  return chart;
}
