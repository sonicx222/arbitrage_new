import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable, type Column } from './DataTable';

interface Row { id: string; name: string; value: number }

const ROWS: Row[] = [
  { id: '1', name: 'Alice', value: 10 },
  { id: '2', name: 'Bob', value: 20 },
];

const BASE_COLUMNS: Column<Row>[] = [
  { header: 'Name', render: (r) => <>{r.name}</> },
  { header: 'Value', align: 'right', render: (r) => <>{r.value}</> },
];

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------
describe('DataTable', () => {
  it('renders column headers', () => {
    render(<DataTable columns={BASE_COLUMNS} data={ROWS} keyExtractor={(r) => r.id} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Value')).toBeInTheDocument();
  });

  it('renders data rows', () => {
    render(<DataTable columns={BASE_COLUMNS} data={ROWS} keyExtractor={(r) => r.id} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows empty message when data is empty', () => {
    render(<DataTable columns={BASE_COLUMNS} data={[]} keyExtractor={(r) => r.id} emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows default empty message', () => {
    render(<DataTable columns={BASE_COLUMNS} data={[]} keyExtractor={(r) => r.id} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Keyboard accessibility (P0-5)
  // ---------------------------------------------------------------------------
  describe('sortable header accessibility', () => {
    const onClick = vi.fn();

    const sortableColumns: Column<Row>[] = [
      { header: 'Name', onHeaderClick: onClick, render: (r) => <>{r.name}</> },
      { header: 'Value', render: (r) => <>{r.value}</> },
    ];

    it('renders a <button> inside sortable <th> preserving header semantics', () => {
      render(<DataTable columns={sortableColumns} data={ROWS} keyExtractor={(r) => r.id} />);
      const btn = screen.getByRole('button', { name: /Name/ });
      expect(btn.tagName).toBe('BUTTON');
      // Button should be inside a <th> (column header semantics preserved)
      expect(btn.closest('th')).not.toBeNull();
    });

    it('does NOT render a button for non-sortable headers', () => {
      render(<DataTable columns={sortableColumns} data={ROWS} keyExtractor={(r) => r.id} />);
      const valueHeader = screen.getByText('Value');
      expect(valueHeader.closest('th')).not.toBeNull();
      expect(valueHeader.querySelector('button')).toBeNull();
    });

    it('fires onHeaderClick on Enter key (native button behavior)', () => {
      onClick.mockClear();
      render(<DataTable columns={sortableColumns} data={ROWS} keyExtractor={(r) => r.id} />);
      // Native <button> converts Enter keypress to click; simulate with fireEvent.click
      fireEvent.click(screen.getByRole('button', { name: /Name/ }));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it('fires onHeaderClick on Space key', () => {
      onClick.mockClear();
      render(<DataTable columns={sortableColumns} data={ROWS} keyExtractor={(r) => r.id} />);
      const el = screen.getByRole('button', { name: /Name/ });
      const ev = fireEvent.keyDown(el, { key: ' ' });
      expect(onClick).toHaveBeenCalledOnce();
      // Space should be prevented to avoid page scroll
      // fireEvent returns false when preventDefault was called
      expect(ev).toBe(false);
    });

    it('does NOT fire onHeaderClick on other keys', () => {
      onClick.mockClear();
      render(<DataTable columns={sortableColumns} data={ROWS} keyExtractor={(r) => r.id} />);
      const el = screen.getByRole('button', { name: /Name/ });
      fireEvent.keyDown(el, { key: 'Tab' });
      fireEvent.keyDown(el, { key: 'a' });
      expect(onClick).not.toHaveBeenCalled();
    });

    it('fires onHeaderClick on mouse click', () => {
      onClick.mockClear();
      render(<DataTable columns={sortableColumns} data={ROWS} keyExtractor={(r) => r.id} />);
      fireEvent.click(screen.getByRole('button', { name: /Name/ }));
      expect(onClick).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // aria-sort (M-1)
  // ---------------------------------------------------------------------------
  describe('aria-sort', () => {
    it('sets aria-sort from sortDirection prop on the <th>', () => {
      const columns: Column<Row>[] = [
        { header: 'Name', onHeaderClick: vi.fn(), sortDirection: 'ascending', render: (r) => <>{r.name}</> },
      ];
      render(<DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />);
      const th = screen.getByRole('button', { name: /Name/ }).closest('th')!;
      expect(th).toHaveAttribute('aria-sort', 'ascending');
    });

    it('sets aria-sort to descending on the <th>', () => {
      const columns: Column<Row>[] = [
        { header: 'Name', onHeaderClick: vi.fn(), sortDirection: 'descending', render: (r) => <>{r.name}</> },
      ];
      render(<DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />);
      const th = screen.getByRole('button', { name: /Name/ }).closest('th')!;
      expect(th).toHaveAttribute('aria-sort', 'descending');
    });

    it('does NOT set aria-sort when sortDirection is undefined', () => {
      const columns: Column<Row>[] = [
        { header: 'Name', onHeaderClick: vi.fn(), render: (r) => <>{r.name}</> },
      ];
      render(<DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />);
      expect(screen.getByRole('button', { name: /Name/ })).not.toHaveAttribute('aria-sort');
    });
  });

  // ---------------------------------------------------------------------------
  // headerSuffix
  // ---------------------------------------------------------------------------
  it('renders headerSuffix alongside header text', () => {
    const columns: Column<Row>[] = [
      { header: 'Name', headerSuffix: ' \u25B2', render: (r) => <>{r.name}</> },
    ];
    render(<DataTable columns={columns} data={ROWS} keyExtractor={(r) => r.id} />);
    expect(screen.getByText(/Name.*\u25B2/)).toBeInTheDocument();
  });
});
