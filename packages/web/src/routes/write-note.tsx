import { RetainerApiError } from '@retainer/sdk';
import type { FieldView, LogEventInput } from '@retainer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { NotebookPen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { fields } from '../fields/index.js';
import { Button, Dialog, Form, FormField, Input, Notice, Row, Textarea } from '../ui/index.js';
import { useApiName } from './developer.js';
import { eventColumnField, noteType } from './event-list.js';

/** The channel notes written in the web app are logged under. */
export const NOTE_CHANNEL = 'web';

export type NoteDraft = { title: string; body: string; occurredAt: string; about: string[] };

/**
 * What `POST /v1/events` gets for a note. The external ID is made once per
 * dialog, so a retry after a lost response finds the same note rather than
 * writing a second one.
 */
export function noteInput(type: string, externalId: string, draft: NoteDraft): LogEventInput {
  const title = draft.title.trim(),
    summary = draft.body.trim();
  return {
    type,
    channel: NOTE_CHANNEL,
    externalId,
    occurredAt: draft.occurredAt,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(draft.about.length ? { about: draft.about } : {}),
  };
}

/** Whether people can write notes here: the base `note` type, `write`, and a user key. */
export function useCanWriteNote() {
  const { session, schema } = useWorkspace();
  return canMutate(session) && !!noteType(schema);
}

/** The **Write a note** button and its dialog. */
export function WriteNoteButton({
  about,
  onSaved,
}: {
  /** Records the note starts about, e.g. the feed's linked record. */
  about?: string[];
  onSaved?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!useCanWriteNote()) return null;
  return (
    <>
      <Button variant="primary" size="small" onClick={() => setOpen(true)}>
        <NotebookPen size={14} />
        Write a note
      </Button>
      {open ? (
        <WriteNoteDialog
          about={about}
          onClose={() => setOpen(false)}
          onSaved={(id) => {
            setOpen(false);
            onSaved?.(id);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Title, body, when, and the records it is about. Participants are not asked
 * for: a note is about records, not with people (5.4). It is logged as the
 * signed-in person, under the `web` channel.
 */
export function WriteNoteDialog({
  about = [],
  onClose,
  onSaved,
}: {
  about?: string[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { session, schema } = useWorkspace(),
    client = useQueryClient(),
    apiName = useApiName();
  const type = noteType(schema);
  // `about` names any records; the picker reads "Choose records".
  const aboutField = useMemo<FieldView>(
    () => ({ ...eventColumnField(schema, 'about'), label: 'Records' }),
    [schema],
  );
  const whenField = useMemo<FieldView>(
    () => ({ ...eventColumnField(schema, 'occurredAt'), label: 'Date' }),
    [schema],
  );
  const [draft, setDraft] = useState<NoteDraft>(() => ({
      title: '',
      body: '',
      occurredAt: new Date().toISOString(),
      about,
    })),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    // One per dialog, kept across retries.
    [externalId] = useState(() => crypto.randomUUID());
  const titleField = type?.fields.find((f) => f.coreRole === 'title');
  const summaryField = type?.fields.find((f) => f.coreRole === 'summary');
  const empty = !draft.title.trim() && !draft.body.trim();
  async function save() {
    if (busy || !type || empty) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.logEvent(noteInput(type.nameSingular, externalId, draft));
      void client.invalidateQueries({ queryKey: [session.workspace.id] });
      onSaved(result.id);
    } catch (e) {
      setError(
        e instanceof RetainerApiError && e.code === 'event_conflict'
          ? 'This note was already saved with other values. Close the dialog to see it, then edit it there.'
          : `The note was not saved: ${(e as Error).message}. Try again; it will be saved once.`,
      );
    } finally {
      setBusy(false);
    }
  }
  const DateInput = fields.date_time.Input,
    AboutInput = fields.relation.Input;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Write a note"
      description="Saved as yours, in Activity and on the timeline of each record it is about."
    >
      <Form onSubmit={() => void save()}>
        {error ? <Notice error>{error}</Notice> : null}
        {!type ? <Notice error>This workspace has no note event type.</Notice> : null}
        <FormField label="Title" apiName={apiName(titleField?.name)}>
          <Input
            aria-label="Title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
        </FormField>
        <FormField label="Note" apiName={apiName(summaryField?.name)}>
          <Textarea
            aria-label="Note"
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
        </FormField>
        <FormField label="Date" apiName={apiName('occurredAt')}>
          <DateInput
            field={whenField}
            value={draft.occurredAt}
            onChange={(v) =>
              setDraft((d) => ({ ...d, occurredAt: typeof v === 'string' ? v : d.occurredAt }))
            }
          />
        </FormField>
        <FormField label="About" apiName={apiName('about')} hint="Optional">
          <AboutInput
            field={aboutField}
            value={draft.about}
            onChange={(v) =>
              setDraft((d) => ({ ...d, about: Array.isArray(v) ? (v as string[]) : [] }))
            }
          />
        </FormField>
        <Row>
          <Button type="submit" variant="primary" disabled={busy || !type || empty}>
            {busy ? 'Saving…' : 'Save note'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </Row>
      </Form>
    </Dialog>
  );
}
