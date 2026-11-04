import type { FieldView, ObjectView, SchemaDescription, Session } from '@retainer/shared';
import { isPolymorphic, relationTargets } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../api/client.js';
import {
  FieldDisplay,
  FieldFilter,
  FieldInput,
  FieldPicker,
  filterValue,
  interleave,
  joinOr,
} from './common.js';

// Links need a router; plain anchors are enough to find them by name.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

afterEach(() => vi.restoreAllMocks());

const A = '10000000-0000-4000-8000-00000000000a',
  B = '10000000-0000-4000-8000-00000000000b',
  C = '10000000-0000-4000-8000-00000000000c';
const customer: FieldView = {
  type: 'relation',
  name: 'customer',
  label: 'Customer',
  description: null,
  settings: { targetObjects: ['company', 'person'], relationCardinality: 'many_to_one' },
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  readOnly: false,
  owner: 'workspace',
  isProtected: false,
};
const customers: FieldView = {
  ...customer,
  name: 'customers',
  label: 'Customers',
  settings: { ...customer.settings, relationCardinality: 'many_to_many' },
};
const references = {
  [A]: { id: A, object: 'company', label: 'Acme' },
  [B]: { id: B, object: 'person', label: 'Acme' },
};
const objects = [
  { nameSingular: 'company', labelSingular: 'Company', labelPlural: 'Companies', fields: [] },
  { nameSingular: 'person', labelSingular: 'Person', labelPlural: 'People', fields: [] },
] as unknown as ObjectView[];

function renderIn(children: ReactNode) {
  const workspace = {
    session: { workspace: { id: 'w1' } } as unknown as Session,
    schema: { objects } as unknown as SchemaDescription,
  };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}
/** Companies and people named Acme, answered per object as the server would. */
function searchRecords() {
  return vi.spyOn(api, 'queryRecords').mockImplementation(
    async (object) =>
      ({
        records:
          object === 'company'
            ? [{ id: A, object: 'company', label: 'Acme' }]
            : [
                { id: B, object: 'person', label: 'Acme' },
                { id: C, object: 'person', label: 'Bea' },
              ],
        nextCursor: null,
      }) as never,
  );
}

describe('polymorphic relations', () => {
  it('reads its allowed objects from either settings form', () => {
    expect(relationTargets(customer)).toEqual(['company', 'person']);
    expect(relationTargets({ settings: { targetObject: 'person' } })).toEqual(['person']);
    expect(relationTargets({ settings: {} })).toEqual([]);
    expect(isPolymorphic(customer)).toBe(true);
    expect(isPolymorphic({ type: 'relation', settings: { targetObject: 'person' } })).toBe(false);
    expect(joinOr(['Company', 'Person', 'Deal'])).toBe('Company, Person or Deal');
    expect(joinOr(['Company'])).toBe('Company');
  });

  it("merges each object's results in turn, so none is buried", () => {
    expect(interleave([[1, 2, 3], [10], [20, 21]])).toEqual([1, 10, 20, 2, 21, 3]);
    expect(interleave([])).toEqual([]);
  });

  it('searches every allowed object once and names each result’s object', async () => {
    const query = searchRecords();
    const onChange = vi.fn();
    renderIn(<FieldPicker field={customer} value={null} onChange={onChange} />);
    // Interleaved: each object's first match, then the rest.
    await screen.findByRole('option', { name: 'Acme (Company)' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'No customer',
      'Acme (Company)',
      'Acme (Person)',
      'Bea (Person)',
    ]);
    // One query per object, sharing the list's length, never one per record.
    expect(query.mock.calls.map(([object, input]) => [object, input])).toEqual([
      ['company', { search: undefined, limit: 25 }],
      ['person', { search: undefined, limit: 25 }],
    ]);
    expect(screen.getByRole('combobox', { name: 'Customer' }).getAttribute('placeholder')).toBe(
      'Search companies or people…',
    );
    await userEvent.click(screen.getByRole('option', { name: 'Acme (Person)' }));
    expect(onChange).toHaveBeenLastCalledWith(B);
    await userEvent.type(screen.getByRole('combobox', { name: 'Customer' }), 'ac');
    await vi.waitFor(() =>
      expect(query.mock.calls.slice(2).map(([object, input]) => [object, input])).toEqual([
        ['company', { search: 'ac', limit: 25 }],
        ['person', { search: 'ac', limit: 25 }],
      ]),
    );
  });

  it('keeps chosen members of a set listed with their objects', async () => {
    searchRecords();
    const onChange = vi.fn();
    renderIn(
      <FieldPicker field={customers} value={[A]} onChange={onChange} references={references} />,
    );
    await screen.findByRole('option', { name: 'Bea (Person)' });
    expect(
      screen.getByRole('option', { name: 'Acme (Company)' }).getAttribute('aria-selected'),
    ).toBe('true');
    await userEvent.click(screen.getByRole('option', { name: 'Acme (Person)' }));
    expect(onChange).toHaveBeenLastCalledWith([A, B]);
  });

  it('shows the chosen record with its object on a form button', () => {
    renderIn(<FieldInput field={customer} value={B} onChange={vi.fn()} references={references} />);
    expect(screen.getByRole('button').textContent).toBe('Acme (Person)');
  });

  it('tags each linked record with its object only where the field links several', () => {
    const { container, unmount } = renderIn(
      <FieldDisplay field={customers} value={[A, B]} references={references} />,
    );
    expect(container.textContent).toBe('Acme (Company)Acme (Person)');
    expect(screen.getAllByRole('link', { name: 'Acme' })).toHaveLength(2);
    unmount();
    const single = { ...customers, settings: { targetObject: 'company' } };
    const plain = renderIn(<FieldDisplay field={single} value={[A]} references={references} />);
    expect(plain.container.textContent).toBe('Acme');
  });

  it('filters one record by any of several, chosen from the same picker', () => {
    expect(filterValue(customer, 'in', [A, B])).toEqual([A, B]);
    expect(filterValue(customer, 'eq', B)).toBe(B);
    expect(() => filterValue(customer, 'in', '')).toThrow('Choose at least one record');
    renderIn(<FieldFilter field={customer} operator="in" value="" onChange={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button').textContent).toBe('Choose customer');
  });
});
