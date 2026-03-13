import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Bottom margin — defaults to 'mb-2' */
  mb?: 'mb-2' | 'mb-3';
}

const BASE = 'text-[11px] text-gray-500 uppercase tracking-wider';

export function SectionHeader({ children, mb = 'mb-2' }: Props) {
  return <h3 className={`${BASE} ${mb}`}>{children}</h3>;
}
