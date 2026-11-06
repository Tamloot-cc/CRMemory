// biome-ignore-all lint/a11y/useSemanticElements: Sourced-value triggers can contain relation links; native buttons would nest interactive controls.
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ReactNode, useRef, useState } from 'react';
export function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false);
  // On a tap, focus arrives after the press and opens the tooltip, so a plain
  // toggle on click would shut it again. The click goes by whether it was open
  // at the press instead, and prevents the default so Radix's own click handler
  // doesn't close it.
  const openAtPress = useRef(false);
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onPointerDown={() => {
              openAtPress.current = open;
            }}
            onClick={(e) => {
              // A link inside the trigger still navigates.
              if ((e.target as Element).closest('a')) return;
              e.preventDefault();
              setOpen(!openAtPress.current);
              openAtPress.current = false;
            }}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                setOpen((v) => !v);
              }
            }}
            className="cursor-help decoration-dotted underline-offset-4 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {children}
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={5}
            className="z-50 max-w-sm rounded-lg border border-border bg-popover p-3 text-sm text-foreground shadow-md"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
