import type { Config } from '../config.js';
import { parseSigningKeys } from './access.js';
import { Backend } from './backend.js';

/** The backend for a loaded configuration. */
export function backendFromConfig(config: Config): Backend {
  const backend = new Backend({
    url: config.RETAINER_SURREAL_URL,
    namespace: config.RETAINER_SURREAL_NAMESPACE,
    admin: {
      user: config.RETAINER_SURREAL_USER,
      pass: config.RETAINER_SURREAL_PASS,
      level: config.RETAINER_SURREAL_AUTH_LEVEL,
    },
    signingKeys: parseSigningKeys({
      current: config.RETAINER_SIGNING_KEY,
      ...(config.RETAINER_SIGNING_PREVIOUS_KEYS
        ? { previous: config.RETAINER_SIGNING_PREVIOUS_KEYS }
        : {}),
      ...(config.RETAINER_SIGNING_REVOKED_KEY_IDS
        ? { revoked: config.RETAINER_SIGNING_REVOKED_KEY_IDS }
        : {}),
    }),
  });
  backend.queues.limitMs = config.RETAINER_WRITE_QUEUE_LIMIT_MS;
  return backend;
}
