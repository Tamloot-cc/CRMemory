import type { Actor, AssertionView, FieldView, Provenance } from '@retainer/shared';
import { Bot, Cog, Plug, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { fields } from '../fields/index.js';
import {
  Badge,
  InteractionLink,
  Muted,
  ReviewLink,
  Row,
  Sourced,
  Stack,
  Tooltip,
} from '../ui/index.js';
export function ActorBadge({ actor }: { actor: Actor }) {
  const Icon = { agent: Bot, user: UserRound, integration: Plug, system: Cog }[actor.type];
  return (
    <Badge>
      <Icon size={12} aria-hidden="true" />
      {actor.name || actor.id}
      <span>· {actor.type}</span>
    </Badge>
  );
}
export function AssertionSource({ assertion }: { assertion: AssertionView }) {
  return (
    <Stack>
      <ActorBadge actor={assertion.actor} />
      <Muted>Observed {new Date(assertion.observedAt).toLocaleString()}</Muted>
      {assertion.source ? (
        <InteractionLink id={assertion.source.id}>
          {assertion.source.title || 'Untitled interaction'} ·{' '}
          {new Date(assertion.source.occurredAt).toLocaleDateString()}
        </InteractionLink>
      ) : (
        <Muted>No live source interaction</Muted>
      )}
      {assertion.reviewedBy ? (
        <Row>
          <Muted>Reviewed by</Muted>
          <ActorBadge actor={assertion.reviewedBy} />
        </Row>
      ) : null}
    </Stack>
  );
}
export function SourcedValue({
  provenance,
  viewer,
  field,
  children,
}: {
  provenance?: Provenance;
  viewer: Actor;
  field: FieldView;
  children: ReactNode;
}) {
  const a = provenance?.assertion;
  const other = a && (a.actor.type !== viewer.type || a.actor.id !== viewer.id);
  return (
    <Row>
      {other ? (
        <Tooltip content={<AssertionSource assertion={a} />}>
          <Sourced>{children}</Sourced>
        </Tooltip>
      ) : (
        children
      )}
      {provenance?.pendingAssertionIds.length ? (
        <Tooltip content={<PendingPreview field={field} assertion={provenance.pendingAssertion} />}>
          <ReviewLink
            id={provenance.pendingAssertion?.id ?? provenance.pendingAssertionIds[0] ?? ''}
          >
            Pending review
            {provenance.pendingAssertionIds.length > 1
              ? ` (${provenance.pendingAssertionIds.length})`
              : ''}
          </ReviewLink>
        </Tooltip>
      ) : null}
    </Row>
  );
}

function PendingPreview({
  field,
  assertion,
}: {
  field: FieldView;
  assertion?: AssertionView | null;
}) {
  const Display = fields[field.type].Display;
  return (
    <Stack>
      <Muted>Proposed value</Muted>
      {assertion ? (
        <Display field={field} value={assertion.value} references={assertion.relationReferences} />
      ) : (
        <Muted>Open the review item to see its proposal.</Muted>
      )}
    </Stack>
  );
}
