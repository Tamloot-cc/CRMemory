import { readFileSync } from 'node:fs';

/**
 * Read from package.json, which sits one level above both `src` and `dist`,
 * including in the Docker image (`pnpm deploy` copies it next to `dist`).
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
