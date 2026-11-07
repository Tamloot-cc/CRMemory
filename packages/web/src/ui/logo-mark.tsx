import { type CSSProperties, useEffect, useId, useReducer } from 'react';
import { cn } from './core.js';
import './logo-mark.css';

/**
 * Each mood (see docs/specs/assistant-avatar.md): the keyframes in logo-mark.css
 * whose cycle it waits for, how long one cycle takes (the CSS reads it as
 * `--mark-cycle`), and whether it plays once.
 */
export const CYCLE = {
  idle: { name: 'retainer-mark-drift', ms: 3200, once: false },
  listening: { name: 'retainer-mark-breathe', ms: 1600, once: false },
  thinking: { name: 'retainer-mark-spin', ms: 1400, once: false },
  reading: { name: 'retainer-mark-scan', ms: 2400, once: false },
  saving: { name: 'retainer-mark-stash', ms: 2200, once: false },
  working: { name: 'retainer-mark-step', ms: 1600, once: false },
  done: { name: 'retainer-mark-whirl', ms: 900, once: true },
  error: { name: 'retainer-mark-shake', ms: 600, once: true },
} as const satisfies Record<string, { name: string; ms: number; once: boolean }>;
export type LogoMood = keyof typeof CYCLE;

/** The mood on screen, and the one it changes to when the current cycle ends. */
export interface MoodState {
  shown: LogoMood;
  next: LogoMood | null;
}

export type MoodEvent =
  /** The caller asks for a mood; `now` skips waiting (nothing is moving). */
  | { type: 'want'; mood: LogoMood; now: boolean }
  /** An animation in the mark finished a cycle (`ended`: it played once and stopped). */
  | { type: 'cycle'; name: string; ended: boolean };

/**
 * A mood changes only when the shown one finishes a cycle, where every mood is
 * back at rest, so the mark never jumps. One-shot moods (done, error) return to
 * idle when they end, unless another mood is waiting.
 */
export function moodReducer(state: MoodState, event: MoodEvent): MoodState {
  if (event.type === 'want') {
    if (event.now) return { shown: event.mood, next: null };
    if (event.mood === state.shown) return state.next ? { shown: state.shown, next: null } : state;
    return state.next === event.mood ? state : { shown: state.shown, next: event.mood };
  }
  const cycle = CYCLE[state.shown];
  // Several layers (the square's counter-turn, the gradient mask's copy of the ring)
  // run the same keyframes and report the same cycle; once the mood has changed,
  // the later reports no longer match it.
  if (event.name !== cycle.name || event.ended !== cycle.once) return state;
  if (state.next) return { shown: state.next, next: null };
  return cycle.once ? { shown: 'idle', next: null } : state;
}

const prefersReducedMotion = () =>
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The ring and the square, as drawn in public/logo.svg.
const RING =
  'M 528 128.67731389 A 300 300 0 1 0 665.32998323 260 L 549.74979132 260 A 205 205 0 1 1 528 239.87192626 Z';
// The whole 800 viewBox and a margin, for the gradient layer and its mask.
const COVER = { x: -100, y: -100, width: 1000, height: 1000 };

/**
 * The Retainer mark, moving to show what the assistant (or a page) is doing.
 * Without a tile it is lime on dark pages and a lime-to-forest gradient on light
 * ones; `tile` puts it on the dark tile in both. Give it a `label` when nothing
 * next to it says what is happening; otherwise it is decorative.
 */
export function LogoMark({
  mood = 'idle',
  size = 32,
  tile = false,
  label,
  className,
}: {
  mood?: LogoMood;
  /** Width and height in CSS pixels. Below 32 the square gets hard to see. */
  size?: number;
  tile?: boolean;
  label?: string;
  className?: string;
}) {
  const [state, dispatch] = useReducer(moodReducer, { shown: mood, next: null });
  useEffect(() => dispatch({ type: 'want', mood, now: prefersReducedMotion() }), [mood]);

  // Animation events don't arrive when nothing animates (reduced motion, a hidden
  // tab, tests), so a timer finishes the cycle if they don't.
  const cycle = CYCLE[state.shown];
  const waiting = state.next !== null || cycle.once;
  useEffect(() => {
    if (!waiting) return;
    const { name, ms, once } = cycle;
    const timer = setTimeout(() => dispatch({ type: 'cycle', name, ended: once }), ms + 250);
    return () => clearTimeout(timer);
  }, [cycle, waiting]);
  // Only the shown mood's cycle can change anything; skip the rest without a render.
  const onCycle = (name: string, ended: boolean) => {
    if (waiting && name === cycle.name) dispatch({ type: 'cycle', name, ended });
  };

  const id = `retainer-mark-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <span
      className={cn('retainer-mark', className)}
      data-mood={state.shown}
      data-tile={tile ? '' : undefined}
      style={{ width: size, height: size, '--mark-cycle': `${cycle.ms}ms` } as CSSProperties}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      onAnimationIteration={(e) => onCycle(e.animationName, false)}
      onAnimationEnd={(e) => onCycle(e.animationName, true)}
    >
      <svg
        viewBox={tile ? '-225 -225 1250 1250' : '32 32 736 736'}
        width="100%"
        height="100%"
        fill="none"
        aria-hidden
      >
        {tile ? null : (
          <>
            <defs>
              <linearGradient
                id={`${id}-fade`}
                gradientUnits="userSpaceOnUse"
                x1="700"
                y1="100"
                x2="100"
                y2="700"
              >
                <stop offset="0" stopColor="#D4FA38" />
                <stop offset="0.55" stopColor="#1F5E3A" />
              </linearGradient>
            </defs>
            {/* The gradient stays put while a copy of the ring, turning exactly like the
                visible one, cuts it to shape. Outside <defs> so its animations run. */}
            <mask id={`${id}-ring`} maskUnits="userSpaceOnUse" {...COVER}>
              <g className="mark-breathe">
                <g className="mark-turn">
                  <path d={RING} fill="#fff" />
                </g>
              </g>
            </mask>
            <rect
              className="mark-fixed"
              {...COVER}
              fill={`url(#${id}-fade)`}
              mask={`url(#${id}-ring)`}
            />
          </>
        )}
        <g className="mark-breathe">
          <g className="mark-turn">
            <path className="mark-ring" d={RING} />
            <g className="mark-move">
              <g className="mark-pop">
                <rect className="mark-upright mark-square" x="565" y="129" width="96" height="96" />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}
