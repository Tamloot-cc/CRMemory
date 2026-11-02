import type { Template } from './types.js';

/** Adds nothing; marks the workspace initialized so the agent extends the base objects itself. */
export const blank: Template = {
  name: 'blank',
  version: 1,
  label: 'Blank',
  description: 'Anything else: start from person, company and task, and extend them.',
  operations: [],
};
