import type { CoreRole, FieldView, SchemaOwner } from '@retainer/shared';
import { Bot, Building2, Cog, type LucideIcon } from 'lucide-react';
import { fields } from '../../fields/index.js';
import { Badge, Row } from '../../ui/index.js';

export const CORE_ROLE_TEXT: Record<CoreRole, string> = {
  title: 'Core field: the event’s title, which names it. It can be renamed but not deleted.',
  summary: 'Core field: the event’s summary. It can be renamed but not deleted.',
};

export const OWNERS: Record<SchemaOwner, { label: string; icon: LucideIcon; hint: string }> = {
  system: { label: 'System', icon: Cog, hint: 'Standard; part of every workspace' },
  workspace: { label: 'Workspace', icon: Building2, hint: 'Added by a template or a person' },
  agent: { label: 'Agent', icon: Bot, hint: 'Proposed by an agent and approved' },
};

export function OwnerBadge({ owner }: { owner: SchemaOwner }) {
  const { label, icon: Icon } = OWNERS[owner];
  return (
    <Badge>
      <Icon size={12} aria-hidden />
      {label}
    </Badge>
  );
}

export function FieldTypeLabel({ field }: { field: FieldView }) {
  const type = fields[field.type];
  return (
    <Row>
      <type.icon size={14} aria-hidden />
      {type.label}
    </Row>
  );
}
