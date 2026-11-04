import type { FieldView, PresentedRecord, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import { InlineEditor } from './record-view.js';

const stage: FieldView = {
  type: 'select',
  name: 'stage',
  label: 'Stage',
  description: null,
  settings: {
    options: [
      { value: 'new', label: 'New' },
      { value: 'ready', label: 'Ready' },
      { value: 'won', label: 'Won' },
    ],
  },
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'workspace',
  isProtected: false,
};
const record = {
  id: 'r1',
  updatedAt: '2026-11-03T12:00:00.000Z',
  fields: { stage: 'new' },
} as unknown as PresentedRecord;

function renderEditor(onDone = vi.fn()) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: { objects: [] } as unknown as SchemaDescription,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={workspace}>
        <InlineEditor record={record} field={stage} onDone={onDone} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('InlineEditor', () => {
  it('ignores picks while a save is in flight, so what shows is what was written', async () => {
    let finish: (value: unknown) => void = () => {};
    const patch = vi
      .spyOn(api, 'patchRecord')
      .mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    const onDone = vi.fn();
    renderEditor(onDone);
    await userEvent.click(screen.getByRole('option', { name: 'Ready' }));
    await userEvent.click(screen.getByRole('option', { name: 'Won' }));
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0]?.[1]).toMatchObject({ values: { stage: 'ready' } });
    expect(screen.getByRole('option', { name: 'Ready' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: 'Won' }).getAttribute('aria-selected')).toBe('false');
    finish({ fields: { stage: 'applied' } });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });
  it('closes without writing when the pick is the current value', async () => {
    const patch = vi.spyOn(api, 'patchRecord');
    const onDone = vi.fn();
    renderEditor(onDone);
    await userEvent.click(screen.getByRole('option', { name: 'New' }));
    expect(patch).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });
});
