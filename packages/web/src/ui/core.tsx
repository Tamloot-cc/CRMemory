import { type ClassValue, clsx } from 'clsx';
import { createContext, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** The status colours a badge or a timeline icon can take. */
export type Tone = 'neutral' | 'pending' | 'success' | 'error';

/** Hover and selected backgrounds for the cells of a clickable row (`group` on the row). */
export const ROW_STATE = 'group-hover:bg-hover group-data-selected:bg-muted';

/**
 * Whether a click on a clickable area (a grid row, a field value) is meant
 * for the area itself: not on a control inside it, and not ending a text
 * selection. Tooltip triggers (`role="button"`) wrap most values, so they
 * count as the area.
 */
export function isPlainClick(e: { target: EventTarget | null }) {
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('a,button,input,select,textarea,label,[role="switch"]')) return false;
  return !window.getSelection()?.toString();
}

/** Set by the Shell so pages can open the navigation drawer on small screens. */
export const NavigationContext = createContext<(() => void) | null>(null);

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-background px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
