import type {
  AddressValue,
  EmailsValue,
  FieldView,
  FullNameValue,
  LinksValue,
  MoneyValue,
  PhonesValue,
  RecordReference,
} from '@retainer/shared';
import { FILTER_OPERATORS, normalizeFieldValue } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { type ComponentType, useState } from 'react';
import { api, useWorkspace } from '../api/client.js';
import {
  Badge,
  Button,
  ExternalLink,
  Input,
  Label,
  Muted,
  RecordLink,
  Row,
  Select,
  Stack,
  Textarea,
  Tooltip,
} from '../ui/index.js';
export type DisplayProps = {
  field: FieldView;
  value: unknown;
  compact?: boolean;
  references?: Record<string, RecordReference>;
};
export type InputProps = { field: FieldView; value: unknown; onChange: (value: unknown) => void };
export type FieldModule = {
  Display: ComponentType<DisplayProps>;
  Input: ComponentType<InputProps>;
  Filter: ComponentType<InputProps & { operator: string }>;
  isEmpty: (value: unknown) => boolean;
};
export function isEmptyFor(type: FieldView['type'], value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (type === 'full_name') {
    const v = value as FullNameValue;
    return !v.first && !v.last;
  }
  if (type === 'address')
    return Object.values(value as AddressValue).every((v) => v === undefined || v === '');
  if (type === 'emails' || type === 'phones' || type === 'links') {
    const v = value as { primary: unknown; additional: unknown[] };
    return v.primary === null && !v.additional.length;
  }
  return false;
}
const dateText = (v: string, time = false) => {
  const d = new Date(time ? v : `${v}T12:00:00`);
  return Number.isNaN(d.getTime()) ? v : time ? d.toLocaleString() : d.toLocaleDateString();
};
export function FieldDisplay({ field, value, compact = false, references = {} }: DisplayProps) {
  if (isEmptyFor(field.type, value)) return <Muted>—</Muted>;
  switch (field.type) {
    case 'text':
      return (
        <Tooltip content={String(value)}>
          <span>
            {compact && String(value).length > 60
              ? `${String(value).slice(0, 60)}…`
              : String(value)}
          </span>
        </Tooltip>
      );
    case 'number':
      return <span>{Number(value).toLocaleString()}</span>;
    case 'boolean':
      return (
        <span role="img" aria-label={value ? 'Yes' : 'No'}>
          {value ? '✓' : '—'}
        </span>
      );
    case 'date':
    case 'date_time':
      return (
        <Tooltip content={String(value)}>
          <span>{dateText(String(value), field.type === 'date_time')}</span>
        </Tooltip>
      );
    case 'select':
      return (
        <Badge>
          {field.settings.options?.find((o) => o.value === value)?.label ?? String(value)}
        </Badge>
      );
    case 'multi_select': {
      const values = value as string[];
      return (
        <Row>
          {(compact ? values.slice(0, 2) : values).map((v) => (
            <Badge key={v}>{field.settings.options?.find((o) => o.value === v)?.label ?? v}</Badge>
          ))}
          {compact && values.length > 2 ? <Badge>+{values.length - 2}</Badge> : null}
        </Row>
      );
    }
    case 'money': {
      const v = value as MoneyValue;
      try {
        return (
          <span>
            {new Intl.NumberFormat(undefined, {
              style: 'currency',
              currency: v.currency,
              maximumFractionDigits: 6,
            }).format(v.amountMicros / 1e6)}
          </span>
        );
      } catch {
        return (
          <span>
            {v.amountMicros / 1e6} {v.currency}
          </span>
        );
      }
    }
    case 'full_name': {
      const v = value as FullNameValue;
      return (
        <span>
          {v.first} {v.last}
        </span>
      );
    }
    case 'address': {
      const v = value as AddressValue;
      return (
        <span>
          {(compact
            ? [v.city, v.country]
            : [
                v.street1,
                v.street2,
                v.city,
                v.state,
                v.postcode,
                v.country,
                v.lat !== undefined ? `${v.lat}, ${v.lng}` : undefined,
              ]
          )
            .filter(Boolean)
            .join(', ') || '—'}
        </span>
      );
    }
    case 'relation': {
      const ids = Array.isArray(value) ? value : [value];
      return (
        <Row>
          {ids.map((id) =>
            references[String(id)] ? (
              <RecordLink key={String(id)} id={String(id)}>
                {references[String(id)]?.label || 'Untitled record'}
              </RecordLink>
            ) : (
              <Muted key={String(id)}>Unavailable reference</Muted>
            ),
          )}
        </Row>
      );
    }
    case 'json':
      return compact ? (
        <Tooltip content={JSON.stringify(value, null, 2)}>
          <span>{JSON.stringify(value).slice(0, 60)}</span>
        </Tooltip>
      ) : (
        <Textarea
          aria-label={`${field.label} JSON`}
          readOnly
          value={JSON.stringify(value, null, 2)}
        />
      );
    case 'emails':
    case 'phones':
    case 'links': {
      const v = value as EmailsValue | PhonesValue | LinksValue;
      const values = [v.primary, ...v.additional].filter(Boolean);
      return (
        <Row>
          {(compact ? values.slice(0, 1) : values).map((item) => {
            if (typeof item === 'string') return <span key={item}>{item}</span>;
            if (item && 'url' in item)
              return (
                <ExternalLink key={item.url} href={item.url}>
                  {item.label || new URL(item.url).host}
                </ExternalLink>
              );
            if (item && 'number' in item)
              return (
                <span key={item.number}>
                  {item.number}
                  {item.countryCode ? ` (${item.countryCode})` : ''}
                </span>
              );
            return null;
          })}
          {compact && values.length > 1 ? <Badge>+{values.length - 1}</Badge> : null}
          {values.length === 0 ? <Muted>—</Muted> : null}
        </Row>
      );
    }
  }
}
/** Exact decimal-to-micros conversion; never multiply a floating-point input. */
export function decimalToMicros(raw: string): number {
  if (!/^-?\d+(\.\d{0,6})?$/.test(raw))
    throw new Error('Use a decimal amount with at most 6 fractional digits');
  const negative = raw.startsWith('-');
  const [whole = '', fraction = ''] = raw.replace(/^-/, '').split('.');
  const n = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const signed = negative ? -n : n;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error('Amount is too large');
  return Number(signed);
}
export function microsToDecimal(n: number): string {
  const sign = n < 0 ? '-' : '';
  const v = BigInt(Math.abs(n));
  return (
    `${sign}${v / 1_000_000n}.${String(v % 1_000_000n).padStart(6, '0')}`.replace(/\.?0+$/, '') ||
    '0'
  );
}
function MoneyInput({ value, onChange }: InputProps) {
  const v = (value ?? { amountMicros: 0, currency: 'USD' }) as MoneyValue;
  const [amount, setAmount] = useState(microsToDecimal(v.amountMicros));
  const [error, setError] = useState('');
  return (
    <Stack>
      <Row>
        <Label>
          Amount
          <Input
            aria-invalid={!!error}
            value={amount}
            inputMode="decimal"
            onChange={(e) => {
              setAmount(e.target.value);
              try {
                const amountMicros = decimalToMicros(e.target.value);
                setError('');
                onChange({ ...v, amountMicros });
              } catch (err) {
                setError((err as Error).message);
                onChange({ ...v, amountMicros: Number.NaN });
              }
            }}
          />
        </Label>
        <Label>
          Currency
          <Select
            aria-label="Currency"
            value={v.currency}
            onChange={(e) => onChange({ ...v, currency: e.target.value })}
          >
            {Array.from(new Set([v.currency, ...Intl.supportedValuesOf('currency')])).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Label>
      </Row>
      {error ? <Muted>{error}</Muted> : null}
    </Stack>
  );
}
function RelationInput({ field, value, onChange }: InputProps) {
  const workspace = useWorkspace();
  const [search, setSearch] = useState('');
  const target = workspace.schema.objects.find(
    (o) => o.nameSingular === field.settings.targetObject,
  );
  const query = useQuery({
    queryKey: [workspace.session.workspace.id, 'relationPicker', target?.nameSingular, search],
    queryFn: ({ signal }) =>
      api.queryRecords(
        target?.nameSingular ?? '',
        { search: search.trim() || undefined, limit: 50 },
        signal,
      ),
    enabled: !!target,
  });
  return (
    <Stack>
      <Input
        aria-label="Search related records"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search records…"
      />
      <Select
        aria-label={field.label}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Choose a record</option>
        {value && !query.data?.records.some((r) => r.id === value) ? (
          <option value={String(value)}>Current record</option>
        ) : null}
        {query.data?.records.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label || r.id}
          </option>
        ))}
      </Select>
      {query.error ? <Muted>{query.error.message}</Muted> : null}
    </Stack>
  );
}
function ListInput({ field, value, onChange }: InputProps) {
  type Item = string | { number: string; countryCode?: string } | { url: string; label?: string };
  const v = (value ?? { primary: null, additional: [] }) as {
    primary: Item | null;
    additional: Item[];
  };
  const values = [...(v.primary !== null ? [v.primary] : []), ...v.additional];
  const commit = (items: Item[]) =>
    onChange({ primary: items[0] ?? null, additional: items.slice(1) });
  const edit = (i: number, raw: Item) => commit(values.map((v, n) => (n === i ? raw : v)));
  return (
    <Stack>
      {values.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Controlled positional list; all values live in the parent editor.
        <Row key={i}>
          <Badge>{i === 0 ? 'Primary' : i + 1}</Badge>
          {typeof item === 'string' ? (
            <Input
              aria-label={`Email ${i + 1}`}
              type="email"
              value={item}
              onChange={(e) => edit(i, e.target.value)}
            />
          ) : 'number' in item ? (
            <>
              <Input
                aria-label={`Phone ${i + 1}`}
                type="tel"
                value={item.number}
                onChange={(e) => edit(i, { ...item, number: e.target.value })}
              />
              <Input
                aria-label={`Country code ${i + 1}`}
                placeholder="IL"
                maxLength={2}
                value={item.countryCode ?? ''}
                onChange={(e) => edit(i, { ...item, countryCode: e.target.value || undefined })}
              />
            </>
          ) : (
            <>
              <Input
                aria-label={`URL ${i + 1}`}
                value={item.url}
                placeholder="https://"
                onChange={(e) => edit(i, { ...item, url: e.target.value })}
              />
              <Input
                aria-label={`Link label ${i + 1}`}
                value={item.label ?? ''}
                onChange={(e) => edit(i, { ...item, label: e.target.value })}
              />
            </>
          )}
          {i > 0 ? (
            <Button onClick={() => commit([item, ...values.filter((_, n) => n !== i)])}>
              Set primary
            </Button>
          ) : null}
          <Button onClick={() => commit(values.filter((_, n) => n !== i))}>Remove</Button>
        </Row>
      ))}
      <Button
        disabled={
          field.settings.maxValues !== undefined && values.length >= field.settings.maxValues
        }
        onClick={() =>
          commit([
            ...values,
            field.type === 'emails'
              ? ''
              : field.type === 'phones'
                ? { number: '' }
                : { url: '', label: '' },
          ])
        }
      >
        Add {field.type === 'emails' ? 'email' : field.type === 'phones' ? 'phone' : 'link'}
      </Button>
    </Stack>
  );
}
export function FieldInput(props: InputProps) {
  const { field, value, onChange } = props;
  switch (field.type) {
    case 'json':
      return <FieldDisplay field={field} value={value} />;
    case 'boolean':
      return (
        <Label>
          <Input
            type="checkbox"
            role="switch"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </Label>
      );
    case 'number':
      return (
        <Input
          aria-label={field.label}
          type="number"
          step="any"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'text':
      return (
        <Input
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <Input
          aria-label={field.label}
          type="date"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'date_time': {
      const raw = value ? new Date(String(value)) : null;
      const local =
        raw && Number.isFinite(raw.getTime())
          ? new Date(raw.getTime() - raw.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
          : '';
      return (
        <Input
          aria-label={field.label}
          type="datetime-local"
          value={local}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    }
    case 'select':
      return (
        <Select
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Choose an option</option>
          {field.settings.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'multi_select':
      return (
        <Stack>
          {field.settings.options?.map((o) => (
            <Label key={o.value}>
              <Input
                type="checkbox"
                checked={Array.isArray(value) && value.includes(o.value)}
                onChange={(e) => {
                  const old = (value ?? []) as string[];
                  onChange(e.target.checked ? [...old, o.value] : old.filter((v) => v !== o.value));
                }}
              />
              {o.label}
            </Label>
          ))}
        </Stack>
      );
    case 'full_name': {
      const v = (value ?? { first: '', last: '' }) as FullNameValue;
      return (
        <Row>
          <Label>
            First name
            <Input value={v.first} onChange={(e) => onChange({ ...v, first: e.target.value })} />
          </Label>
          <Label>
            Last name
            <Input value={v.last} onChange={(e) => onChange({ ...v, last: e.target.value })} />
          </Label>
        </Row>
      );
    }
    case 'address': {
      const v = (value ?? {}) as AddressValue;
      return (
        <Stack>
          {(['street1', 'street2', 'city', 'state', 'postcode', 'country'] as const).map((k) => (
            <Label key={k}>
              {k}
              <Input value={v[k] ?? ''} onChange={(e) => onChange({ ...v, [k]: e.target.value })} />
            </Label>
          ))}
          {v.lat !== undefined || v.lng !== undefined ? (
            <Muted>
              Coordinates: {v.lat}, {v.lng}
            </Muted>
          ) : null}
        </Stack>
      );
    }
    case 'money':
      return <MoneyInput {...props} />;
    case 'emails':
    case 'phones':
    case 'links':
      return <ListInput {...props} />;
    case 'relation':
      return <RelationInput {...props} />;
  }
}
export function FieldFilter({
  field,
  value,
  onChange,
  operator,
}: InputProps & { operator: string }) {
  if (operator === 'isNull')
    return (
      <Select
        aria-label="Is empty"
        value={value === false ? 'false' : 'true'}
        onChange={(e) => onChange(e.target.value === 'true')}
      >
        <option value="true">Is empty</option>
        <option value="false">Is not empty</option>
      </Select>
    );
  if (field.type === 'money')
    return (
      <Input
        aria-label="Amount to compare"
        inputMode="decimal"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (operator === 'in')
    return (
      <Textarea
        aria-label="Filter values as JSON array"
        value={typeof value === 'string' ? value : JSON.stringify(value ?? [])}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (
    ['emails', 'phones', 'links', 'full_name', 'address'].includes(field.type) ||
    field.type === 'multi_select'
  )
    return (
      <Input
        aria-label="Filter value"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return <FieldInput field={field} value={value} onChange={onChange} />;
}
export function filterValue(field: FieldView, operator: string, value: unknown): unknown {
  if (operator === 'isNull') return value !== false;
  if (field.type === 'money') return decimalToMicros(String(value));
  if (operator === 'in') {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('Use a nonempty JSON array');
    return parsed;
  }
  if (['emails', 'phones', 'links', 'full_name', 'address', 'multi_select'].includes(field.type))
    return value;
  return normalizeFieldValue(field, value);
}
export const operatorsFor = (field: FieldView) => [...FILTER_OPERATORS[field.type], 'isNull'];
