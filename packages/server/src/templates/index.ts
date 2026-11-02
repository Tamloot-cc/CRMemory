import { blank } from './blank.js';
import { clinic } from './clinic.js';
import { realEstate } from './real-estate.js';
import { recruiting } from './recruiting.js';
import { sales } from './sales.js';
import { services } from './services.js';
import type { Template, TemplateName } from './types.js';

export { BASE_OBJECT_IDS, BASE_OPERATIONS } from './base.js';
export { TEMPLATE_NAMES, type Template, type TemplateName } from './types.js';

export const TEMPLATES: Record<TemplateName, Template> = {
  sales,
  services,
  clinic,
  real_estate: realEstate,
  recruiting,
  blank,
};

export function getTemplate(name: string): Template | undefined {
  return Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name as TemplateName] : undefined;
}
