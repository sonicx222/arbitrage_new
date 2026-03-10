import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  color?: string;
}

export function StatRow({ label, value, color }: Props) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={color}>{value}</span>
    </div>
  );
}
