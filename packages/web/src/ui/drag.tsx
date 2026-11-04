import {
  type Active,
  type Announcements,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  KeyboardCode,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { type ReactNode, useState } from 'react';

/**
 * Drag and drop for boards and calendars, on dnd-kit (MIT). Items are
 * dragged with the mouse, by touch after a short press (so a swipe still
 * scrolls), or from the keyboard: Space picks an item up, the arrow keys
 * jump to the next drop target in that direction, and Space or Enter drops
 * it; Escape cancels. Every step is announced to screen readers.
 */

/** Data every draggable carries: the target it starts in, and what it is. */
type ItemData = { from: string; item: unknown };

const DIRECTIONS: Partial<Record<string, [number, number]>> = {
  [KeyboardCode.Right]: [1, 0],
  [KeyboardCode.Left]: [-1, 0],
  [KeyboardCode.Down]: [0, 1],
  [KeyboardCode.Up]: [0, -1],
};
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * Arrow keys jump to the nearest drop target in their direction, not a few
 * pixels: the direction counts from the target the item is over, which for
 * an item in a floating panel is not where the item shows.
 */
const jumpToTarget: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = DIRECTIONS[event.code];
  const current = context.collisionRect;
  if (!direction || !current) return undefined;
  event.preventDefault();
  const [dx, dy] = direction;
  const from = (context.over && context.droppableRects.get(context.over.id)) ?? current;
  const cx = from.left + from.width / 2,
    cy = from.top + from.height / 2;
  let best: { x: number; y: number; score: number } | undefined;
  for (const [id, rect] of context.droppableRects) {
    if (!rect || id === context.over?.id) continue;
    const rx = rect.left + rect.width / 2,
      ry = rect.top + rect.height / 2;
    const along = dx ? (rx - cx) * dx : (ry - cy) * dy;
    if (along < 4) continue;
    // How far the target sits off the line the key points along.
    const across = dx
      ? Math.max(0, rect.top - cy, cy - rect.bottom)
      : Math.max(0, rect.left - cx, cx - rect.right);
    const score = along + across * 2;
    if (best && score >= best.score) continue;
    // Land inside the target, as near the current line as it allows.
    const x = dx ? rx : clamp(cx, rect.left + current.width / 2, rect.right - current.width / 2);
    const y = dy ? ry : clamp(cy, rect.top + current.height / 2, rect.bottom - current.height / 2);
    best = { x: x - current.width / 2, y: y - current.height / 2, score };
  }
  return best ? { x: best.x, y: best.y } : undefined;
};

/**
 * The pointer decides where a drop lands; from the keyboard, the most
 * overlapped target. A keyboard drag starts over the item's own target
 * wherever the item shows: a calendar day's "more" panel floats over other
 * days.
 */
const collisions: CollisionDetection = (args) => {
  const initial = args.active.rect.current.initial;
  const from = (args.active.data.current as ItemData | undefined)?.from;
  if (
    !args.pointerCoordinates &&
    from &&
    initial &&
    Math.abs(args.collisionRect.top - initial.top) < 1 &&
    Math.abs(args.collisionRect.left - initial.left) < 1 &&
    args.droppableContainers.some((c) => c.id === from)
  )
    return [{ id: from }];
  const under = pointerWithin(args);
  return under.length ? under : rectIntersection(args);
};

/**
 * Holds draggable items and drop targets. `onMove` runs when an item is
 * dropped on a target other than the one it started in.
 */
export function DragArea<T>({
  children,
  onMove,
  overlay,
  names,
}: {
  children: ReactNode;
  /** The item each `useDragItem` was given, and the target it was dropped on. */
  onMove: (item: T, to: string) => void;
  /** The dragged item as it follows the pointer. */
  overlay: (item: T) => ReactNode;
  /** What items and targets are called in screen-reader announcements. */
  names: { item: (item: T) => string; target: (id: string) => string };
}) {
  const [active, setActive] = useState<{ item: T } | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: jumpToTarget,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space, KeyboardCode.Enter],
      },
    }),
  );
  const itemOf = (a: Active) => (a.data.current as ItemData).item as T;
  const item = (a: Active) => names.item(itemOf(a));
  const target = (id: string | number) => names.target(String(id));
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${item(active)}. Use the arrow keys to move it, Space to drop it, or Escape to cancel.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${item(active)} is over ${target(over.id)}.`
        : `${item(active)} is not over a place to drop it.`,
    onDragEnd: ({ active, over }) =>
      over ? `${item(active)} was dropped on ${target(over.id)}.` : `${item(active)} was put back.`,
    onDragCancel: ({ active }) => `Moving ${item(active)} was cancelled.`,
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To move this item, press Space, use the arrow keys to choose where, then press Space again. Press Escape to cancel.',
        },
      }}
      onDragStart={(e) => setActive({ item: itemOf(e.active) })}
      onDragCancel={() => setActive(null)}
      onDragEnd={(e) => {
        setActive(null);
        const from = (e.active.data.current as ItemData | undefined)?.from;
        if (e.over && String(e.over.id) !== from) onMove(itemOf(e.active), String(e.over.id));
      }}
    >
      {children}
      <DragOverlay dropAnimation={null}>{active ? overlay(active.item) : null}</DragOverlay>
    </DndContext>
  );
}

/** Makes an element draggable as `item`; spread `handle` on it. */
export function useDragItem(id: string, from: string, item: unknown, disabled = false) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { from, item } satisfies ItemData,
    disabled,
  });
  return {
    ref: setNodeRef,
    // Without listeners (disabled) the element keeps its own role and focus.
    handle: disabled ? {} : { ...attributes, ...listeners },
    isDragging,
  };
}

/** Makes an element a place items can be dropped. */
export function useDropTarget(id: string, disabled = false) {
  const { setNodeRef, isOver, active } = useDroppable({ id, disabled });
  const from = (active?.data.current as ItemData | undefined)?.from;
  return { ref: setNodeRef, isOver: isOver && from !== id };
}
