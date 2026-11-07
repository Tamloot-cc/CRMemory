import type { FieldView, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { RollUpEventsSwitch } from './schema.js';

const employer: FieldView = {
  type: 'relation',
  name: 'company',
  label: 'Employer',
  description: null,
  settings: { targetObject: 'company', relationCardinality: 'many_to_one' },
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'system',
  isProtected: true,
};
const person = {
  nameSingular: 'person',
  labelSingular: 'Person',
  class: 'entity',
  fields: [employer],
} as unknown as ObjectView;

function renderSwitch(field: FieldView, scopes: string[] = ['schema:write']) {
  const workspace = {
    session: { workspace: { id: 'w1' }, actor: { type: 'user' }, scopes } as unknown as Session,
    schema: { objects: [person] } as unknown as SchemaDescription,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={workspace}>
        <RollUpEventsSwitch object={person} field={field} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('RollUpEventsSwitch', () => {
  it('turns rollup on with an update_field change, and explains what it does', async () => {
    const propose = vi
      .spyOn(api, 'proposeSchemaChange')
      .mockResolvedValue({ status: 'applied', change: null, schemaVersion: 2 });
    renderSwitch(employer);
    const toggle = screen.getByRole('switch', { name: 'Roll up events' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Events attached to a person also appear on the record/)).toBeTruthy();
    await userEvent.click(toggle);
    expect(propose).toHaveBeenCalledWith([
      { op: 'update_field', object: 'person', field: 'company', rollUpEvents: true },
    ]);
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  });

  it('turns it off, and shows why a change failed', async () => {
    const propose = vi.spyOn(api, 'proposeSchemaChange').mockResolvedValue({
      status: 'failed',
      change: { error: 'Not allowed here' } as never,
      schemaVersion: 1,
    });
    renderSwitch({ ...employer, settings: { ...employer.settings, rollUpEvents: true } });
    await userEvent.click(screen.getByRole('switch', { name: 'Roll up events' }));
    expect(propose.mock.calls[0]?.[0]).toEqual([
      { op: 'update_field', object: 'person', field: 'company', rollUpEvents: false },
    ]);
    expect(await screen.findByText('Not allowed here')).toBeTruthy();
  });

  it('only shows the setting without schema:write', () => {
    renderSwitch({ ...employer, settings: { ...employer.settings, rollUpEvents: true } }, ['read']);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(/also appear on the record it points to/)).toBeTruthy();
  });
});
