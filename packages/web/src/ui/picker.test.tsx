import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { filterOptions, OptionList, type PickerOption, SelectMenu } from './picker.js';
import { PropertyEditor } from './property.js';

const OPTIONS: PickerOption[] = [
  { value: 'new', label: 'New' },
  { value: 'ready', label: 'Ready' },
  { value: 'ils', label: 'ILS', keywords: 'Israeli New Shekel' },
  { value: 'cafe', label: 'Café' },
];
function Many() {
  const [values, setValues] = useState<string[]>(['new']);
  return (
    <OptionList
      label="Topics"
      multiple
      options={OPTIONS}
      selected={values}
      onPick={(v) =>
        setValues((old) => (old.includes(v) ? old.filter((x) => x !== v) : [...old, v]))
      }
    />
  );
}
function One() {
  const [value, setValue] = useState<string | null>('new');
  return <SelectMenu label="Stage" options={OPTIONS} value={value} onChange={setValue} />;
}

describe('filterOptions', () => {
  it('matches every word in the label or keywords, ignoring case and accents', () => {
    expect(filterOptions(OPTIONS, '').map((o) => o.value)).toEqual(['new', 'ready', 'ils', 'cafe']);
    expect(filterOptions(OPTIONS, 'shekel').map((o) => o.value)).toEqual(['ils']);
    expect(filterOptions(OPTIONS, 'NEW').map((o) => o.value)).toEqual(['new', 'ils']);
    expect(filterOptions(OPTIONS, 'new israeli').map((o) => o.value)).toEqual(['ils']);
    expect(filterOptions(OPTIONS, 'cafe').map((o) => o.value)).toEqual(['cafe']);
  });
});

describe('OptionList', () => {
  it('filters as you type and picks the first match with Enter', async () => {
    const onPick = vi.fn();
    render(<OptionList label="Stage" options={OPTIONS} selected={[]} onPick={onPick} />);
    const search = screen.getByRole('combobox', { name: 'Stage' });
    await userEvent.type(search, 'rea');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Ready']);
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('ready');
  });
  it('moves the highlight with the arrow keys and marks it for assistive tech', async () => {
    const onPick = vi.fn();
    render(<OptionList label="Stage" options={OPTIONS} selected={['ready']} onPick={onPick} />);
    const search = screen.getByRole('combobox', { name: 'Stage' });
    search.focus();
    expect(search.getAttribute('aria-activedescendant')).toBeNull();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    const active = document.getElementById(search.getAttribute('aria-activedescendant') ?? '');
    expect(active?.textContent).toBe('Ready');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    // Back above the first option: nothing is highlighted, so Enter isn't a pick.
    expect(search.getAttribute('aria-activedescendant')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onPick).not.toHaveBeenCalled();
  });
  it('toggles many choices and clears the search after a typed pick', async () => {
    render(<Many />);
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    await userEvent.click(screen.getByRole('option', { name: 'New' }));
    expect(screen.getByRole('option', { name: 'New' }).getAttribute('aria-selected')).toBe('false');
    const search = screen.getByRole('combobox', { name: 'Topics' });
    await userEvent.type(search, 'caf{Enter}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'Café' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });
  it('without a search box, the list itself takes the keys', async () => {
    const onPick = vi.fn();
    render(
      <OptionList
        label="Active"
        searchable={false}
        options={OPTIONS.slice(0, 2)}
        selected={[]}
        onPick={onPick}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    screen.getByRole('listbox', { name: 'Active' }).focus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('ready');
  });
  it('picks nothing from a remote search until its results match what was typed', async () => {
    const onPick = vi.fn(),
      onSubmit = vi.fn();
    const list = (searching: boolean) => (
      <form onSubmit={onSubmit}>
        <OptionList
          label="Company"
          options={searching ? OPTIONS.slice(0, 1) : OPTIONS.slice(1, 2)}
          onSearchChange={vi.fn()}
          searching={searching}
          onPick={onPick}
        />
      </form>
    );
    const { rerender } = render(list(true));
    const search = screen.getByRole('combobox', { name: 'Company' });
    await userEvent.type(search, 'rea{Enter}');
    expect(search.getAttribute('aria-activedescendant')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(list(false));
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('ready');
  });
  it('lists a clearing choice only before typing, so Enter after a search picks a match', async () => {
    const onPick = vi.fn();
    render(
      <OptionList
        label="Company"
        options={[{ value: '', label: 'No company', unsearched: true }, ...OPTIONS]}
        onSearchChange={vi.fn()}
        onPick={onPick}
      />,
    );
    expect(screen.getByRole('option', { name: 'No company' })).toBeTruthy();
    await userEvent.type(screen.getByRole('combobox', { name: 'Company' }), 'acme{Enter}');
    expect(screen.queryByRole('option', { name: 'No company' })).toBeNull();
    expect(onPick).toHaveBeenCalledWith('new');
  });
  it('says when nothing matches', async () => {
    render(<OptionList label="Stage" options={OPTIONS} selected={[]} onPick={vi.fn()} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Stage' }), 'zzz');
    expect(screen.getByText('No matches')).toBeTruthy();
  });
});

describe('SelectMenu', () => {
  it('shows the choice on its button and closes after a single pick', async () => {
    render(<One />);
    const button = screen.getByRole('button', { name: 'Stage New' });
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('option', { name: 'Ready' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stage Ready' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stage Ready' }));
  });
  it('stays open to pick several', async () => {
    const onChange = vi.fn();
    render(
      <SelectMenu label="Topics" multiple options={OPTIONS} value={['new']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Topics/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Ready' }));
    expect(onChange).toHaveBeenCalledWith(['new', 'ready']);
    expect(screen.getByRole('listbox')).toBeTruthy();
  });
  it('keeps Enter in its search from saving the editor it was opened from', async () => {
    const onSave = vi.fn();
    render(
      <PropertyEditor onSave={onSave} onCancel={vi.fn()}>
        <SelectMenu label="Currency" options={OPTIONS} value="new" onChange={vi.fn()} searchable />
      </PropertyEditor>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Currency/ }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search currency' }));
    await userEvent.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('PropertyEditor with a list', () => {
  it('saves a picked list on a click outside and on ⌘/Ctrl+Enter, and cancels on Escape', async () => {
    const onSave = vi.fn(),
      onCancel = vi.fn(),
      onOutside = vi.fn();
    render(
      <>
        <button type="button">Elsewhere</button>
        <PropertyEditor kind="picker" onSave={onSave} onCancel={onCancel} onOutside={onOutside}>
          <OptionList label="Topics" multiple options={OPTIONS} selected={[]} onPick={vi.fn()} />
        </PropertyEditor>
      </>,
    );
    const search = screen.getByRole('combobox', { name: 'Topics' });
    expect(document.activeElement).toBe(search);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(onSave).toHaveBeenCalledOnce();
    // Enter with nothing highlighted leaves the list, saving it.
    await userEvent.keyboard('{Enter}');
    expect(onSave).toHaveBeenCalledTimes(2);
    // With an option highlighted, Enter picks it instead.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSave).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onOutside).toHaveBeenCalledOnce();
    search.focus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
