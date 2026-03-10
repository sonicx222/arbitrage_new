import { memo } from 'react';

interface Props {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

export const KpiCard = memo(function KpiCard({ label, value, sub, color = 'text-gray-100' }: Props) {
  return (
    <div className="card flex flex-col gap-1">
      <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-display font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-gray-600 mt-0.5">{sub}</span>}
    </div>
  );
});
