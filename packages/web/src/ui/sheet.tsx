import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

/** Marks an element whose Escape key belongs to it (an inline editor), not to the sheet. */
export const OWNS_ESCAPE = 'data-owns-escape';

/**
 * A panel that slides in from the right edge over the page, for a record
 * opened from a list. It is non-modal: the page behind stays usable, so
 * opening another row swaps the content without closing the sheet first.
 * The close button and Escape close it; Escape inside an element marked
 * `OWNS_ESCAPE` (an inline editor) is left to that element.
 */
export function Sheet({
  open,
  onOpenChange,
  eyebrow,
  title,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: string;
  /** Read by assistive technology as the sheet's name; shown as the heading. */
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={panel}
          onOpenAutoFocus={(e) => {
            // Focus the panel itself rather than its first control.
            e.preventDefault();
            panel.current?.focus();
          }}
          // Clicking the list behind opens another record; it must not close the sheet.
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest(`[${OWNS_ESCAPE}]`)) e.preventDefault();
          }}
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-2xl outline-none sm:w-[min(38rem,92vw)] motion-safe:data-[state=closed]:animate-sheet-out motion-safe:data-[state=open]:animate-sheet-in"
        >
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
            <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground first-letter:uppercase">
              {eyebrow}
            </div>
            {actions}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close"
                title="Close (Esc)"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={16} />
              </button>
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="flex flex-col gap-6 px-5 py-5">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Record details. Click a value to edit it.
              </DialogPrimitive.Description>
              {children}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
