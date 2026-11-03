import dagre from '@dagrejs/dagre';

export interface Box {
  id: string;
  width: number;
  height: number;
}

/** A link from a "many" box to the "one" box it points at. */
export interface Link {
  id: string;
  from: string;
  to: string;
  /** Where the link meets each box, measured down from the box's top. */
  fromY: number;
  toY: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Side = 'left' | 'right';

/** Space between columns, where the lines turn, and between boxes in a column. */
const GAP_X = 112,
  GAP_Y = 40;

/**
 * How a link runs between columns: down the vertical lanes it was given
 * (`lanes[0]` beside the many box, `lanes[1]` beside the one box) and, when
 * it skips columns, along `via`, a height the layout kept clear for it.
 */
export interface Route {
  lanes: number[];
  via?: number;
}

export interface Layout {
  /** Top-left corner of each box. */
  positions: Map<string, Point>;
  routes: Map<string, Route>;
}

/**
 * Lays the boxes out in columns from left to right: the boxes others point
 * at come first, so every line reads "many → one" from right to left. Boxes
 * with no links share the first column; self-links don't affect the layout.
 *
 * Then routes each link: a link between neighbouring columns turns once, in
 * the gap between them; a link that skips columns runs along the clear height
 * dagre kept for it, so it passes above or below the boxes in between instead
 * of under them. Lines in the same gap get their own lanes where their
 * heights overlap, so they never share a vertical segment.
 */
export function layoutDiagram(boxes: Box[], links: Link[]): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', ranksep: GAP_X, nodesep: GAP_Y, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of boxes) g.setNode(b.id, { width: b.width, height: b.height });
  const known = links.filter((l) => l.from !== l.to && g.hasNode(l.from) && g.hasNode(l.to));
  for (const l of known) g.setEdge(l.to, l.from, {}, l.id);
  dagre.layout(g);

  const positions = new Map<string, Point>(
    boxes.map((b) => {
      const { x, y } = g.node(b.id);
      return [b.id, { x: x - b.width / 2, y: y - b.height / 2 }];
    }),
  );
  // dagre lines up the centres of a column; the gap after a column runs from
  // its widest box to the next column's.
  const centreOf = (b: Box) => Math.round((positions.get(b.id)?.x ?? 0) + b.width / 2);
  const centres = [...new Set(boxes.map(centreOf))].sort((a, b) => a - b);
  const columnOf = new Map(boxes.map((b) => [b.id, centres.indexOf(centreOf(b))]));
  const column = (id: string) => columnOf.get(id) ?? 0;
  const edgeOf = (c: number, side: 'left' | 'right') => {
    const xs = boxes
      .filter((b) => column(b.id) === c)
      .map((b) => (positions.get(b.id)?.x ?? 0) + (side === 'right' ? b.width : 0));
    return side === 'right' ? Math.max(...xs) : Math.min(...xs);
  };

  // Each vertical segment a link needs: the gap it sits in and the heights it spans.
  interface Segment {
    link: string;
    lane: number;
    gap: number;
    top: number;
    bottom: number;
  }
  const segments: Segment[] = [];
  const vias = new Map<string, number>();
  for (const l of known) {
    const many = column(l.from),
      one = column(l.to);
    if (many === one) continue;
    const yFrom = (positions.get(l.from)?.y ?? 0) + l.fromY,
      yTo = (positions.get(l.to)?.y ?? 0) + l.toY;
    // The gap beside each end, on the side facing the other end.
    const gapMany = many > one ? many - 1 : many,
      gapOne = many > one ? one : one - 1;
    const segment = (lane: number, gapAt: number, a: number, b: number) =>
      segments.push({
        link: l.id,
        lane,
        gap: gapAt,
        top: Math.min(a, b),
        bottom: Math.max(a, b),
      });
    if (Math.abs(many - one) === 1) {
      segment(0, gapMany, yFrom, yTo);
      continue;
    }
    const points = g.edge({ v: l.to, w: l.from, name: l.id }).points;
    const via = (points[Math.floor(points.length / 2)] as Point).y;
    vias.set(l.id, via);
    segment(0, gapMany, yFrom, via);
    segment(1, gapOne, via, yTo);
  }

  // Lanes: in each gap, a segment takes the first lane free at its heights.
  const lanes = new Map<string, number[]>();
  for (const gapAt of new Set(segments.map((s) => s.gap))) {
    const inGap = segments.filter((s) => s.gap === gapAt).sort((a, b) => a.top - b.top);
    const ends: number[] = [];
    const laneOf = inGap.map((s) => {
      let i = ends.findIndex((end) => end + 12 < s.top);
      if (i < 0) i = ends.push(s.bottom) - 1;
      else ends[i] = s.bottom;
      return i;
    });
    const from = edgeOf(gapAt, 'right'),
      width = edgeOf(gapAt + 1, 'left') - from;
    inGap.forEach((s, i) => {
      const x = from + ((laneOf[i] as number) + 1) * (width / (ends.length + 1));
      const own = lanes.get(s.link) ?? [];
      own[s.lane] = x;
      lanes.set(s.link, own);
    });
  }

  const routes = new Map<string, Route>(
    [...lanes].map(([id, own]) => [id, { lanes: own, via: vias.get(id) }]),
  );
  return { positions, routes };
}

/**
 * Which side of each of two boxes a link leaves from: the sides that face
 * each other. Worked out from where the boxes are now, so it stays right
 * after someone drags one.
 */
export function linkSides(
  from: Point & { width: number },
  to: Point & { width: number },
): { from: Side; to: Side } {
  return from.x + from.width / 2 > to.x + to.width / 2
    ? { from: 'left', to: 'right' }
    : { from: 'right', to: 'left' };
}

/** The corner points a route passes through, from the many end to the one end. */
export function routePoints(source: Point, target: Point, route: Route): Point[] {
  const [near = source.x, far = near] = route.lanes;
  if (route.via === undefined)
    return [source, { x: near, y: source.y }, { x: near, y: target.y }, target];
  return [
    source,
    { x: near, y: source.y },
    { x: near, y: route.via },
    { x: far, y: route.via },
    { x: far, y: target.y },
    target,
  ];
}

/** An SVG path through the points, with corners rounded by up to `radius`. */
export function roundedPath(points: Point[], radius = 12) {
  const [first, ...rest] = points;
  if (!first) return '';
  let d = `M${first.x} ${first.y}`;
  rest.forEach((p, i) => {
    const prev = points[i] as Point,
      next = rest[i + 1];
    if (!next) {
      d += ` L${p.x} ${p.y}`;
      return;
    }
    const r = Math.min(
      radius,
      Math.hypot(p.x - prev.x, p.y - prev.y) / 2,
      Math.hypot(next.x - p.x, next.y - p.y) / 2,
    );
    const towards = (q: Point) => {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      return { x: p.x + ((q.x - p.x) / len) * r, y: p.y + ((q.y - p.y) / len) * r };
    };
    const a = towards(prev),
      b = towards(next);
    d += ` L${a.x} ${a.y} Q${p.x} ${p.y} ${b.x} ${b.y}`;
  });
  return d;
}
