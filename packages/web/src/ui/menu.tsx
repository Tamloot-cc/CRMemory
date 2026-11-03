import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, PANEL, PLACEMENT } from './core.js';

const ITEM =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:shrink-0';

/**
 * A menu of actions or choices under a trigger: arrow keys move, Enter
 * picks, typing jumps to an item, and Escape closes it.
 */
export function Menu({
  trigger,
  label,
  align = 'start',
  children,
}: {
  trigger: ReactNode;
  label: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  return (
    // Not modal, so a dialog opened from an item gets focus and pointer events.
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          aria-label={label}
          align={align}
          {...PLACEMENT}
          className={cn(
            PANEL,
            'flex max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 max-w-[92vw] flex-col overflow-y-auto p-1',
          )}
        >
          {children}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/** An action; `destructive` for one that cannot be undone. */
export function MenuAction({
  onSelect,
  destructive = false,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      onSelect={onSelect}
      className={cn(ITEM, destructive && 'text-destructive data-highlighted:bg-destructive/10')}
    >
      {children}
    </MenuPrimitive.Item>
  );
}

/** One-of-many choices; the chosen one is checked. */
export function MenuChoices({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.RadioGroup value={value} onValueChange={onChange}>
      {children}
    </MenuPrimitive.RadioGroup>
  );
}
export function MenuChoice({ value, children }: { value: string; children: ReactNode }) {
  return (
    <MenuPrimitive.RadioItem value={value} className={ITEM}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.ItemIndicator>
        <Check size={14} className="text-primary" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}
export function MenuSeparator() {
  return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
