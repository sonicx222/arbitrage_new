import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { Chart } from './Chart';

// ---------------------------------------------------------------------------
// ResizeObserver mock — jsdom does not implement it
// ---------------------------------------------------------------------------
let resizeCallback: ResizeObserverCallback;
const mockDisconnect = vi.fn();

beforeEach(() => {
  mockDisconnect.mockClear();
  global.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      resizeCallback = cb;
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = mockDisconnect;
  } as unknown as typeof ResizeObserver;
});

/** Simulate the container being measured at a given width. */
function triggerResize(width: number) {
  act(() => {
    resizeCallback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
}

interface Datum { time: string; value: number }

const SAMPLE: Datum[] = [
  { time: '10:00', value: 10 },
  { time: '10:01', value: 30 },
  { time: '10:02', value: 20 },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
describe('Chart', () => {
  it('renders placeholder before width is measured', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" ariaLabel="test chart" />,
    );
    // Before ResizeObserver fires, no SVG should be rendered
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders SVG after ResizeObserver provides width', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" ariaLabel="test chart" />,
    );
    triggerResize(400);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('has role="img" and aria-label', () => {
    render(<Chart<Datum> data={SAMPLE} dataKey="value" ariaLabel="Latency over time" />);
    triggerResize(400);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Latency over time');
  });

  it('renders line path for multiple data points', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" />,
    );
    triggerResize(400);
    const paths = container.querySelectorAll('path');
    const linePath = Array.from(paths).find((p) => p.getAttribute('fill') === 'none');
    expect(linePath).toBeDefined();
    // Line should start with M and have L segments
    const d = linePath!.getAttribute('d')!;
    expect(d).toMatch(/^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+)+$/);
  });

  it('renders circle for a single data point', () => {
    const single: Datum[] = [{ time: '10:00', value: 42 }];
    const { container } = render(
      <Chart<Datum> data={single} dataKey="value" />,
    );
    triggerResize(400);
    const circles = container.querySelectorAll('circle');
    // Should have exactly 1 circle (single-point dot, no hover dot)
    expect(circles.length).toBe(1);
  });

  it('renders nothing visible for empty data', () => {
    const { container } = render(
      <Chart<Datum> data={[]} dataKey="value" />,
    );
    triggerResize(400);
    // No path, no circle
    expect(container.querySelectorAll('path').length).toBe(0);
    expect(container.querySelectorAll('circle').length).toBe(0);
  });

  it('renders area fill when fill=true', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" fill />,
    );
    triggerResize(400);
    const paths = container.querySelectorAll('path');
    const areaPath = Array.from(paths).find(
      (p) => p.getAttribute('fill') !== 'none' && p.getAttribute('fill-opacity'),
    );
    expect(areaPath).toBeDefined();
    expect(areaPath!.getAttribute('d')).toContain('Z');
  });

  it('renders grid lines', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" />,
    );
    triggerResize(400);
    // TICK_COUNT = 4, so 5 grid lines (0 through 4 inclusive)
    const gridLines = container.querySelectorAll('line[stroke-dasharray="3 3"]');
    expect(gridLines.length).toBe(5);
  });

  it('renders Y axis labels', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" />,
    );
    triggerResize(400);
    const texts = container.querySelectorAll('text[text-anchor="end"]');
    expect(texts.length).toBe(5); // Same as tick count + 1
  });

  it('applies custom color', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" color="#ff0000" />,
    );
    triggerResize(400);
    const linePath = Array.from(container.querySelectorAll('path')).find(
      (p) => p.getAttribute('fill') === 'none',
    );
    expect(linePath!.getAttribute('stroke')).toBe('#ff0000');
  });

  it('respects yDomain', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" yDomain={[0, 100]} />,
    );
    triggerResize(400);
    // Y axis labels should include 0 and 100
    const labels = Array.from(container.querySelectorAll('text[text-anchor="end"]'))
      .map((el) => el.textContent);
    expect(labels).toContain('0');
    expect(labels).toContain('100');
  });

  it('handles all-zero values without crashing', () => {
    const zeros: Datum[] = [
      { time: '10:00', value: 0 },
      { time: '10:01', value: 0 },
    ];
    const { container } = render(
      <Chart<Datum> data={zeros} dataKey="value" />,
    );
    triggerResize(400);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('uses formatValue for tooltip display', () => {
    const { container } = render(
      <Chart<Datum>
        data={SAMPLE}
        dataKey="value"
        formatValue={(v) => `$${v}`}
      />,
    );
    triggerResize(400);
    // Simulate hover over the chart
    const chartDiv = container.querySelector('[role="img"]')!;
    fireEvent.mouseMove(chartDiv, { clientX: 200, clientY: 100 });
    // Tooltip should be visible with formatted value
    const tooltip = container.querySelector('.font-mono');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toMatch(/^\$/);
  });

  it('hides tooltip on mouse leave', () => {
    const { container } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" />,
    );
    triggerResize(400);
    const chartDiv = container.querySelector('[role="img"]')!;
    fireEvent.mouseMove(chartDiv, { clientX: 200, clientY: 100 });
    expect(container.querySelector('.font-mono')).not.toBeNull();
    fireEvent.mouseLeave(chartDiv);
    expect(container.querySelector('.font-mono')).toBeNull();
  });

  it('disconnects ResizeObserver on unmount', () => {
    const { unmount } = render(
      <Chart<Datum> data={SAMPLE} dataKey="value" />,
    );
    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
