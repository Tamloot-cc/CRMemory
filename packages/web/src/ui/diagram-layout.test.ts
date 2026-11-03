import { describe, expect, it } from 'vitest';
import {
  type Box,
  type Link,
  layoutDiagram,
  linkSides,
  roundedPath,
  routePoints,
} from './diagram-layout.js';

const box = (id: string, rows = 3): Box => ({ id, width: 240, height: 55 + rows * 30 });
const link = (from: string, to: string, fromY = 70, toY = 70): Link => ({
  id: `${from}.${to}`,
  from,
  to,
  fromY,
  toY,
});
// The sales template: everything links to companies; tasks and deals link to people too.
const boxes = ['person', 'company', 'task', 'deal'].map((id) => box(id));
const links = [
  link('person', 'company'),
  link('task', 'person'),
  link('task', 'company', 100),
  link('deal', 'company', 100),
  link('deal', 'person'),
];

describe('diagram layout', () => {
  it('puts the boxes others point at to the left of the boxes pointing at them', () => {
    const { positions } = layoutDiagram(boxes, links);
    const x = (id: string) => positions.get(id)?.x ?? Number.NaN;
    expect(x('company')).toBeLessThan(x('person'));
    expect(x('person')).toBeLessThan(x('task'));
    expect(x('person')).toBeLessThan(x('deal'));
  });

  it('places every box without overlaps', () => {
    const all = [...boxes, box('note', 6)];
    const { positions } = layoutDiagram(all, [...links, link('company', 'company')]);
    const placed = all.map((b) => ({ ...b, ...(positions.get(b.id) as { x: number; y: number }) }));
    for (const [i, a] of placed.entries())
      for (const b of placed.slice(i + 1)) {
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
  });

  it('routes a link that skips a column above or below the boxes in it', () => {
    const { positions, routes } = layoutDiagram(boxes, links);
    const person = positions.get('person') as { y: number };
    for (const id of ['task.company', 'deal.company']) {
      const via = routes.get(id)?.via as number;
      expect(via < person.y || via > person.y + (boxes[0] as Box).height, id).toBe(true);
      expect(routes.get(id)?.lanes).toHaveLength(2);
    }
    expect(routes.get('person.company')?.via).toBeUndefined();
  });

  it('keeps every lane inside its gap and gives overlapping lines their own lanes', () => {
    const { positions, routes } = layoutDiagram(boxes, links);
    const right = (id: string) => (positions.get(id)?.x ?? 0) + 240;
    const left = (id: string) => positions.get(id)?.x ?? 0;
    // The gap between people and tasks/deals holds four vertical segments.
    const lanes = ['task.person', 'deal.person', 'task.company', 'deal.company'].map(
      (id) => routes.get(id)?.lanes[0] as number,
    );
    for (const x of lanes) {
      expect(x).toBeGreaterThan(right('person'));
      expect(x).toBeLessThan(left('task'));
    }
    expect(new Set(lanes).size).toBeGreaterThan(1);
  });

  it('ignores links to unknown boxes and self-links', () => {
    const { positions, routes } = layoutDiagram([box('a')], [link('a', 'ghost'), link('a', 'a')]);
    expect([...positions.keys()]).toEqual(['a']);
    expect(routes.size).toBe(0);
  });

  it('leaves from the sides that face each other', () => {
    const left = { x: 0, y: 0, width: 240 },
      right = { x: 400, y: 0, width: 240 };
    expect(linkSides(right, left)).toEqual({ from: 'left', to: 'right' });
    expect(linkSides(left, right)).toEqual({ from: 'right', to: 'left' });
  });

  it('turns a route into corner points and a rounded path', () => {
    const s = { x: 400, y: 50 },
      t = { x: 100, y: 200 };
    expect(routePoints(s, t, { lanes: [300] })).toEqual([
      s,
      { x: 300, y: 50 },
      { x: 300, y: 200 },
      t,
    ]);
    expect(routePoints(s, t, { lanes: [350, 150], via: 10 }).map((p) => [p.x, p.y])).toEqual([
      [400, 50],
      [350, 50],
      [350, 10],
      [150, 10],
      [150, 200],
      [100, 200],
    ]);
    const d = roundedPath(routePoints(s, t, { lanes: [300] }), 12);
    expect(d.startsWith('M400 50 L312 50 Q300 50 300 62')).toBe(true);
    expect(d.endsWith('L100 200')).toBe(true);
  });
});
