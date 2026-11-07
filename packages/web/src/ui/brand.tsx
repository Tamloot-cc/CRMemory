import { cn } from './core.js';

/** Decorative beside a brand or workspace name; the dark tile preserves contrast. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}logo.svg`}
      alt=""
      width={32}
      height={32}
      className={cn('shrink-0 rounded-md bg-[#111B21]', className)}
    />
  );
}
