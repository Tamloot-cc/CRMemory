import type { SchemaOperation } from '../schema-engine/operations.js';

export const TEMPLATE_NAMES = [
  'sales',
  'services',
  'clinic',
  'real_estate',
  'recruiting',
  'blank',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/**
 * A template adds the objects and fields a kind of business needs (3.1). It
 * is applied through the schema engine as owner `system`, and every
 * operation is additive, so applying one never needs approval.
 */
export type Template = {
  name: TemplateName;
  /** Bumped when a release changes the template; recorded on the workspace. */
  version: number;
  label: string;
  /** Who the template is for. */
  description: string;
  operations: SchemaOperation[];
};
