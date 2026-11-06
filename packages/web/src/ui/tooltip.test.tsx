import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './tooltip.js';

const tap = (target: Element) => userEvent.pointer({ keys: '[TouchA]', target });

describe('Tooltip', () => {
  it('opens on a tap and closes on the next, with no hover to open it', async () => {
    render(<Tooltip content="Plain words">About</Tooltip>);
    const trigger = screen.getByRole('button', { name: 'About' });
    await tap(trigger);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Plain words');
    await tap(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('leaves a link inside the trigger to navigate', () => {
    render(
      <Tooltip content="Plain words">
        <a href="#record">Acme</a>
      </Tooltip>,
    );
    const link = screen.getByRole('link', { name: 'Acme' });
    const click = createEvent.click(link);
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(false);
  });
});
