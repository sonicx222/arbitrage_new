interface Props {
  message: string;
  className?: string;
}

export function EmptyState({ message, className = 'text-xs' }: Props) {
  return <div className={`text-gray-600 ${className}`}>{message}</div>;
}
