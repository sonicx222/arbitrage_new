// dashboard/src/components/KpiCard.tsx
interface Props {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

export function KpiCard({ label, value, sub, color = 'text-gray-100' }: Props) {
  return (
    <div className="card flex flex-col">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-gray-500 mt-0.5">{sub}</span>}
    </div>
  );
}
