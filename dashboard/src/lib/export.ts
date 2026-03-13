// Client-side CSV export utility.
// Generates a CSV string from headers + rows and triggers a browser download.

function escapeCsvValue(val: unknown): string {
  if (val == null) return '';
  let str = String(val);
  // P2-19: Prevent CSV formula injection — prefix dangerous leading chars with a tab
  const first = str.charAt(0);
  if (first === '=' || first === '+' || first === '-' || first === '@') {
    str = '\t' + str;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\t')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvValue).join(','));
  }
  return lines.join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
