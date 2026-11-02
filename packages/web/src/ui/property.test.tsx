import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Property, PropertyEditor } from './property.js';
import { Sheet } from './sheet.js';

function Editor({ onSave = vi.fn(), onCancel = vi.fn(), onAdd = vi.fn() }) {
  return (
    <PropertyEditor onSave={onSave} onCancel={onCancel}>
      <input aria-label="Job title" defaultValue="CTO" />
      <button type="button" onClick={onAdd}>
        Add email
      </button>
    </PropertyEditor>
  );
}
function Harness({ onClose }: { onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <Sheet title="Dana Levi" description="Record details" onClose={onClose}>
      {editing ? (
        <PropertyEditor onSave={() => setEditing(false)} onCancel={() => setEditing(false)}>
          <input aria-label="Job title" defaultValue="CTO" />
        </PropertyEditor>
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
    </Sheet>
  );
}

describe('Property', () => {
  it('starts editing when the value is clicked, but not when a link inside it is', async () => {
    const onEdit = vi.fn();
    render(
      <Property label="Company" onEdit={onEdit}>
        <span>Acme</span> <a href="#target">Open Acme</a>
      </Property>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Open Acme' }));
    expect(onEdit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Acme'));
    expect(onEdit).toHaveBeenCalledOnce();
  });
  it('does nothing on click without onEdit', async () => {
    render(
      <Property label="Metadata">
        <span>{'{}'}</span>
      </Property>,
    );
    await userEvent.click(screen.getByText('{}'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('PropertyEditor', () => {
  it('focuses and selects the first control', () => {
    render(<Editor />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Job title' });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });
  it('saves on Enter, cancels on Escape, and plain buttons do not submit', async () => {
    const onSave = vi.fn(),
      onCancel = vi.fn(),
      onAdd = vi.fn();
    render(<Editor onSave={onSave} onCancel={onCancel} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add email' }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Job title' }), '{Enter}');
    expect(onSave).toHaveBeenCalledOnce();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('Sheet', () => {
  it('lets Escape cancel an inline edit first, then close the sheet', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Dana Levi' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Job title' }));
    // Even with focus moved off the editor to the sheet itself, Escape is the editor's first.
    screen.getByRole('dialog').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Job title' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('stays open when the page behind it is clicked', async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Another row</button>
        <Sheet title="Dana Levi" description="Record details" onClose={onClose}>
          <span>Body</span>
        </Sheet>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Another row' }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
