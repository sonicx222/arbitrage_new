/** Shimmer placeholder for loading states. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-gray-800 ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

/** KPI-row shaped skeleton matching KpiGrid layout. */
export function KpiSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card space-y-2 py-3">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-5 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Table-shaped skeleton with header and rows. */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="card space-y-2" role="status" aria-label="Loading table">
      <Skeleton className="h-3 w-32 mb-3" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
