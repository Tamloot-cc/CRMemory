import { type ClassValue, clsx } from 'clsx';
import { createContext, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** Set by the Shell so pages can open the navigation drawer on small screens. */
export const NavigationContext = createContext<(() => void) | null>(null);

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-background px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
