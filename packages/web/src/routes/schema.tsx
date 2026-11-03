import {
  type FieldView,
  type ObjectView,
  SCHEMA_CHANGE_STATUSES,
  type SchemaChange,
  type SchemaChangeStatus,
  type SchemaOwner,
} from '@retainer/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  Bot,
  Building2,
  CircleCheck,
  CircleX,
  Clock,
  Cog,
  KeyRound,
  Lock,
  type LucideIcon,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { api, canMutate, useWorkspace } from '../api/client.js';
import { fields } from '../fields/index.js';
import { ActorBadge } from '../provenance/index.js';
import {
  Badge,
  Button,
  CardGrid,
  Check,
  Code,
  Empty,
  EntityHeader,
  Input,
  Muted,
  NavItem,
  NavList,
  Notice,
  objectIcon,
  Page,
  Panel,
  Property,
  PropertyList,
  Row,
  Section,
  Select,
  Sheet,
  SplitView,
  Stack,
  Table,
  Tabs,
  Td,
  TextButton,
  Timeline,
  TimelineItem,
  type Tone,
  Tooltip,
  Tr,
} from '../ui/index.js';
import {
  describeOperation,
  findObject,
  matchesField,
  parseStatus,
  relativeTime,
  typeDetail,
} from './schema-model.js';
import { QueryError, sortObjects, useView } from './state.js';

const OWNERS: Record<SchemaOwner, { label: string; icon: LucideIcon; hint: string }> = {
  system: { label: 'System', icon: Cog, hint: 'Standard; part of every workspace' },
  workspace: { label: 'Workspace', icon: Building2, hint: 'Added by a template or a person' },
  agent: { label: 'Agent', icon: Bot, hint: 'Proposed by an agent and approved' },
};
function OwnerBadge({ owner }: { owner: SchemaOwner }) {
  const { label, icon: Icon } = OWNERS[owner];
  return (
    <Badge>
      <Icon size={12} aria-hidden />
      {label}
    </Badge>
  );
}

function FieldTypeLabel({ field }: { field: FieldView }) {
  const type = fields[field.type];
  return (
    <Row>
      <type.icon size={14} aria-hidden />
      {type.label}
    </Row>
  );
}

/** The flags shown as table columns and, in words, in the field sheet. */
const FLAGS: { label: string; on: (f: FieldView) => boolean; yes: string; no: string }[] = [
  {
    label: 'Required',
    on: (f) => !f.isNullable,
    yes: 'Every record must have a value',
    no: 'Can be empty',
  },
  {
    label: 'Unique',
    on: (f) => f.isUnique,
    yes: 'No two records can share a value',
    no: 'Values can repeat',
  },
  {
    label: 'Filterable',
    on: (f) => f.isFilterable,
    yes: 'Lists can be filtered by it',
    no: 'Not offered as a filter',
  },
  {
    label: 'Searchable',
    on: (f) => f.isSearchable,
    yes: 'Included in keyword search',
    no: 'Not searched',
  },
];

/**
 * A page of schema changes. The counts in the tab and top bar read `total`
 * from the first page, so opening the history reuses them; the proposed
 * first page is the review inbox's query too.
 */
function useSchemaChanges(status?: SchemaChangeStatus, cursor?: string) {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [session.workspace.id, 'schemaChanges', status ?? 'all', cursor],
    queryFn: ({ signal }) => api.schemaChanges({ status, cursor, limit: 50, signal }),
  });
}

export function SchemaPage() {
  const { schema } = useWorkspace(),
    { search, setSearch } = useView();
  const tab = search.tab === 'history' ? 'history' : 'objects';
  const proposed = useSchemaChanges('proposed');
  const all = useSchemaChanges();
  const pending = proposed.data?.total ?? 0;
  const templates = schema.workspace.templates.map((t) => t.name).join(', ');
  return (
    <Page
      eyebrow="Workspace structure"
      title="Schema"
      description={[
        `Version ${schema.workspace.schemaVersion}`,
        templates ? `Template: ${templates}` : null,
        'Agents propose changes; people approve them.',
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        pending ? (
          <Button size="small" asChild>
            <Link to="/" search={{ tab: 'schema' }}>
              <Clock size={14} aria-hidden />
              {pending} proposed
            </Link>
          </Button>
        ) : null
      }
    >
      <Tabs
        value={tab}
        onChange={(v) =>
          void setSearch({ tab: v, cursor: undefined, field: undefined, status: undefined })
        }
        items={[
          { value: 'objects', label: 'Objects', count: schema.objects.length },
          { value: 'history', label: 'Change history', count: all.data?.total },
        ]}
      />
      {tab === 'objects' ? <ObjectsTab /> : <HistoryTab />}
    </Page>
  );
}

function ObjectsTab() {
  const { session, schema } = useWorkspace(),
    { search, setSearch } = useView();
  const objects = sortObjects(schema.objects);
  const object = findObject(objects, search.object) ?? objects[0];
  const field = object?.fields.find((f) => f.name === search.field);
  const select = (object: string, field?: string) => void setSearch({ object, field });
  return (
    <>
      {!schema.workspace.templates.length ? <TemplatePicker /> : null}
      {object ? (
        <SplitView
          nav={
            <NavList label="Objects">
              {objects.map((o) => (
                <NavItem
                  key={o.nameSingular}
                  icon={objectIcon(o.nameSingular)}
                  label={o.labelPlural}
                  meta={o.fields.length}
                  active={o.nameSingular === object.nameSingular}
                  onSelect={() => select(o.nameSingular)}
                />
              ))}
            </NavList>
          }
        >
          <ObjectDetail
            key={object.nameSingular}
            object={object}
            selectedField={field?.name}
            onOpenField={(name) => select(object.nameSingular, name)}
          />
        </SplitView>
      ) : (
        <Empty
          title="No objects yet"
          description={
            canMutate(session, 'schema:write')
              ? 'Apply a template above, or let an agent propose objects.'
              : 'Objects appear here once a template is applied or an agent’s proposal is approved.'
          }
        />
      )}
      {object && field ? (
        <FieldSheet
          object={object}
          field={field}
          onClose={() => void setSearch({ field: undefined })}
          onNavigate={select}
        />
      ) : null}
    </>
  );
}

/** Keyed by object, so the field filter starts empty for each one. */
function ObjectDetail({
  object,
  selectedField,
  onOpenField,
}: {
  object: ObjectView;
  selectedField?: string;
  onOpenField: (name: string) => void;
}) {
  const { schema } = useWorkspace();
  const [query, setQuery] = useState('');
  const label = object.fields.find((f) => f.name === object.labelField);
  const shown = object.fields.filter((f) => matchesField(f, query));
  return (
    <>
      <EntityHeader
        icon={objectIcon(object.nameSingular)}
        title={object.labelPlural}
        meta={
          <>
            <Code>{object.nameSingular}</Code>
            <Code>{object.namePlural}</Code>
            <OwnerBadge owner={object.owner} />
            {label ? <span>Records named by {label.label}</span> : null}
          </>
        }
        description={object.description}
        actions={
          <Button size="small" variant="ghost" asChild>
            <Link to="/o/$object" params={{ object: object.nameSingular }}>
              Browse records
              <ArrowUpRight size={14} aria-hidden />
            </Link>
          </Button>
        }
      />
      <Row>
        <div>
          <Input
            type="search"
            aria-label="Filter fields"
            placeholder="Filter fields…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Muted>
          {query ? `${shown.length} of ${object.fields.length}` : object.fields.length}{' '}
          {object.fields.length === 1 ? 'field' : 'fields'}
        </Muted>
      </Row>
      {shown.length ? (
        <Table
          headers={[
            { label: 'Field' },
            { label: 'Type' },
            ...FLAGS.map((f) => ({ label: f.label, align: 'center' as const })),
            { label: 'Owner' },
          ]}
        >
          {shown.map((f) => {
            const detail = typeDetail(f, schema.objects);
            return (
              <Tr
                key={f.name}
                selected={f.name === selectedField}
                onOpen={() => onOpenField(f.name)}
              >
                <Td first>
                  <Row>
                    <TextButton onClick={() => onOpenField(f.name)}>{f.label}</TextButton>
                    {f.name === object.labelField ? (
                      <Tooltip content="Names this object’s records wherever they are referenced.">
                        <KeyRound size={13} aria-label="Label field" />
                      </Tooltip>
                    ) : null}
                    {f.readOnly ? (
                      <Tooltip content="Read only: written by the server, not directly.">
                        <Lock size={13} aria-label="Read only" />
                      </Tooltip>
                    ) : null}
                  </Row>
                  <Code>{f.name}</Code>
                </Td>
                <Td>
                  <FieldTypeLabel field={f} />
                  {detail ? <Muted>{detail}</Muted> : null}
                </Td>
                {FLAGS.map((flag) => (
                  <Td key={flag.label} align="center">
                    <Check value={flag.on(f)} />
                  </Td>
                ))}
                <Td>
                  <OwnerBadge owner={f.owner} />
                </Td>
              </Tr>
            );
          })}
        </Table>
      ) : (
        <Empty
          title={query ? 'No matching fields' : 'No fields'}
          description={query ? `Nothing in ${object.labelPlural} matches “${query}”.` : undefined}
        />
      )}
    </>
  );
}

function FieldSheet({
  object,
  field,
  onClose,
  onNavigate,
}: {
  object: ObjectView;
  field: FieldView;
  onClose: () => void;
  onNavigate: (object: string, field?: string) => void;
}) {
  const { schema } = useWorkspace();
  const s = field.settings;
  const target = findObject(schema.objects, s.targetObject);
  const inverse = target?.fields.find((f) => f.name === s.inverseField);
  const flags = [
    ...FLAGS.map((f) => ({ ...f, on: f.on(field) })),
    {
      label: 'Read only',
      on: field.readOnly,
      yes:
        s.relationCardinality === 'one_to_many' && target && inverse
          ? `The inverse side; write ${target.labelSingular} → ${inverse.label} instead`
          : 'Written by the server, not directly',
      no: 'Agents and people can write it',
    },
  ];
  return (
    <Sheet
      eyebrow={`${object.labelSingular} · field`}
      title={field.label}
      description={`Definition of the ${field.label} field`}
      onClose={onClose}
    >
      {field.description ? <Muted>{field.description}</Muted> : null}
      <Section title="Definition">
        <PropertyList>
          <Property label="API name">
            <Code>{field.name}</Code>
          </Property>
          <Property label="Type">
            <FieldTypeLabel field={field} />
          </Property>
          <Property label="Owner">
            <Row>
              <OwnerBadge owner={field.owner} />
              <Muted>{OWNERS[field.owner].hint}</Muted>
            </Row>
          </Property>
          {field.name === object.labelField ? (
            <Property label="Label field">
              Names {object.labelPlural.toLowerCase()} wherever they are referenced
            </Property>
          ) : null}
          {s.maxValues ? <Property label="Most values">{s.maxValues}</Property> : null}
          {field.universalId ? (
            <Property label="Universal ID">
              <Code>{field.universalId}</Code>
            </Property>
          ) : null}
        </PropertyList>
      </Section>
      {field.type === 'relation' ? (
        <Section title="Relation">
          <PropertyList>
            <Property label="Links to">
              {target ? (
                <TextButton onClick={() => onNavigate(target.nameSingular)}>
                  {target.labelPlural}
                </TextButton>
              ) : (
                <Code>{s.targetObject ?? 'unknown'}</Code>
              )}
            </Property>
            <Property label="Cardinality">
              {s.relationCardinality === 'one_to_many'
                ? `Each ${object.labelSingular.toLowerCase()} has many ${target?.labelPlural.toLowerCase() ?? 'records'}`
                : `Each ${object.labelSingular.toLowerCase()} has one ${target?.labelSingular.toLowerCase() ?? 'record'}`}
            </Property>
            {s.inverseField ? (
              <Property label="Other side">
                {target && inverse ? (
                  <TextButton onClick={() => onNavigate(target.nameSingular, inverse.name)}>
                    {target.labelSingular} → {inverse.label}
                  </TextButton>
                ) : (
                  <Code>{s.inverseField}</Code>
                )}
              </Property>
            ) : null}
            {s.onDelete ? (
              <Property label="If target is deleted">
                {s.onDelete === 'cascade'
                  ? `Delete the ${object.labelSingular.toLowerCase()} too`
                  : 'Clear this link'}
              </Property>
            ) : null}
          </PropertyList>
        </Section>
      ) : null}
      {s.options ? (
        <Section title={`Options (${s.options.length})`}>
          {s.options.length ? (
            <PropertyList>
              {s.options.map((o) => (
                <Property key={o.value} label={o.label}>
                  <Code>{o.value}</Code>
                </Property>
              ))}
            </PropertyList>
          ) : (
            <Muted>No options yet.</Muted>
          )}
        </Section>
      ) : null}
      <Section title="Behaviour">
        <PropertyList>
          {flags.map((f) => (
            <Property key={f.label} label={f.label}>
              <Row>
                <Check value={f.on} />
                <Muted>{f.on ? f.yes : f.no}</Muted>
              </Row>
            </Property>
          ))}
        </PropertyList>
      </Section>
    </Sheet>
  );
}

function TemplatePicker() {
  const { session, schema } = useWorkspace(),
    client = useQueryClient();
  const templates = useQuery({
    queryKey: [session.workspace.id, 'templates'],
    queryFn: ({ signal }) => api.templates(signal),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const allowed = canMutate(session, 'schema:write');
  async function apply(name: string) {
    setBusy(true);
    setError('');
    try {
      await api.applyTemplate(name);
      await client.invalidateQueries({ queryKey: [session.workspace.id] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Start from a template">
      <Muted>
        {schema.objects.length
          ? 'A template adds the objects and fields for a kind of work. Agents can extend it later.'
          : 'This workspace has no objects yet. A template adds the objects and fields for a kind of work.'}
      </Muted>
      {error ? <Notice error>{error}</Notice> : null}
      {templates.error ? <QueryError error={templates.error} /> : null}
      <CardGrid>
        {templates.data?.templates.map((t) => (
          <Panel key={t.name} title={t.label}>
            <Stack>
              <Muted>{t.description}</Muted>
              {allowed ? (
                <Row>
                  <Button variant="primary" disabled={busy} onClick={() => void apply(t.name)}>
                    Apply {t.label}
                  </Button>
                </Row>
              ) : null}
            </Stack>
          </Panel>
        ))}
      </CardGrid>
    </Section>
  );
}

const STATUS: Record<SchemaChangeStatus, { label: string; icon: LucideIcon; tone: Tone }> = {
  applied: { label: 'Applied', icon: CircleCheck, tone: 'success' },
  proposed: { label: 'Proposed', icon: Clock, tone: 'pending' },
  rejected: { label: 'Rejected', icon: CircleX, tone: 'neutral' },
  failed: { label: 'Failed', icon: TriangleAlert, tone: 'error' },
};

function HistoryTab() {
  const { session } = useWorkspace(),
    { search, setSearch } = useView();
  const status = parseStatus(search.status);
  const changes = useSchemaChanges(status, search.cursor);
  const canAdmin = canMutate(session, 'admin');
  return (
    <Stack>
      <Row>
        <Select
          aria-label="Status"
          value={status ?? ''}
          onChange={(e) =>
            void setSearch({ status: e.target.value || undefined, cursor: undefined })
          }
        >
          <option value="">All statuses</option>
          {SCHEMA_CHANGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </Select>
        {changes.data ? (
          <Muted>
            {changes.data.total} {changes.data.total === 1 ? 'change' : 'changes'}
          </Muted>
        ) : null}
      </Row>
      {changes.error ? (
        <QueryError error={changes.error} retry={() => void changes.refetch()} />
      ) : null}
      {changes.isPending ? <Notice>Loading history…</Notice> : null}
      {changes.data && !changes.data.changes.length ? (
        <Empty
          title={status ? `No ${STATUS[status].label.toLowerCase()} changes` : 'No changes yet'}
          description="Changes appear here when an agent proposes one or a template is applied."
        />
      ) : null}
      {changes.data?.changes.length ? (
        <Panel>
          <Timeline label="Schema changes">
            {changes.data.changes.map((c) => (
              <ChangeItem key={c.id} change={c} canDecide={canAdmin} />
            ))}
          </Timeline>
        </Panel>
      ) : null}
      {search.cursor || changes.data?.nextCursor ? (
        <Row>
          {search.cursor ? (
            <Button onClick={() => void setSearch({ cursor: undefined })}>Newest</Button>
          ) : null}
          {changes.data?.nextCursor ? (
            <Button
              onClick={() => void setSearch({ cursor: changes.data?.nextCursor ?? undefined })}
            >
              Older changes
            </Button>
          ) : null}
        </Row>
      ) : null}
    </Stack>
  );
}

function ChangeItem({ change, canDecide }: { change: SchemaChange; canDecide: boolean }) {
  const { objects } = useWorkspace().schema;
  const s = STATUS[change.status];
  return (
    <TimelineItem icon={s.icon} tone={s.tone}>
      <Row>
        <Badge tone={s.tone}>{s.label}</Badge>
        {change.appliedVersion ? <Muted>v{change.appliedVersion}</Muted> : null}
        {change.isDestructive ? <Badge>Destructive</Badge> : null}
        <Muted>
          <time dateTime={change.createdAt} title={new Date(change.createdAt).toLocaleString()}>
            {relativeTime(change.createdAt)}
          </time>
        </Muted>
      </Row>
      {change.request.map((op, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a change's operations never reorder.
        <div key={i}>{describeOperation(op, objects)}</div>
      ))}
      {change.reason ? <Muted>“{change.reason}”</Muted> : null}
      <Row>
        <Muted>By</Muted>
        <ActorBadge actor={change.requestedBy} />
        {change.decidedBy ? (
          <>
            <Muted>{change.status === 'rejected' ? 'rejected by' : 'approved by'}</Muted>
            <ActorBadge actor={change.decidedBy} />
          </>
        ) : null}
      </Row>
      {change.error ? <Notice error>{change.error}</Notice> : null}
      {canDecide && change.status === 'proposed' ? (
        <Row>
          <Button size="small" asChild>
            <Link to="/" search={{ tab: 'schema' }}>
              Review in inbox
            </Link>
          </Button>
        </Row>
      ) : null}
    </TimelineItem>
  );
}
