export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M8 11h16v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z"
        fill="none"
        stroke="white"
        strokeWidth="2"
      />
      <path d="m8 11 8 6 8-6" fill="none" stroke="white" strokeWidth="2" />
      <path d="m13 18 2 2 4-4" fill="none" stroke="#9ff0c4" strokeWidth="2" />
    </svg>
  );
}
