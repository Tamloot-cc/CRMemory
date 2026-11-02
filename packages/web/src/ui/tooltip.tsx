// biome-ignore-all lint/a11y/useSemanticElements: Sourced-value triggers can contain relation links; native buttons would nest interactive controls.
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ReactNode, useState } from 'react';
export function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
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
