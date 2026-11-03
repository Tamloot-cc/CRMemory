import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cn } from './core.js';

/** An anchored panel for menus and small forms (filters, columns). */
export function Popover({
  trigger,
  label,
  open,
  onOpenChange,
  align = 'start',
  children,
}: {
  trigger: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={label}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 flex max-h-[min(70vh,32rem)] w-[min(92vw,20rem)] flex-col gap-3 overflow-auto rounded-lg border border-border bg-popover p-3 text-foreground shadow-lg"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A form laid out for popovers and dialogs. */
export function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
/** A full-width action in a menu; `destructive` for one that cannot be undone. */
export function MenuButton({
  onClick,
  destructive = false,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:shrink-0',
          destructive && 'text-destructive',
        )}
      >
        {children}
      </button>
    </li>
  );
}
export function MenuHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium">{title}</span>
      {action}
    </div>
  );
}
export function MenuList({ children }: { children: ReactNode }) {
  return <ul className="-mx-1 flex flex-col">{children}</ul>;
}
export function MenuItem({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <li
      className={cn(
        'flex h-8 items-center gap-1 rounded-md px-1 hover:bg-hover',
        muted && 'text-muted-foreground',
      )}
    >
      {children}
    </li>
  );
}
