import { parseArgs } from 'node:util';
import { createApiKey, listApiKeys, parseActor, parseScopes, revokeApiKey } from '../auth/keys.js';
import { generateSigningKeyEntry } from '../db/access.js';
import type { Backend } from '../db/backend.js';
import { AppError } from '../errors.js';
import { rebuildSearchDocuments } from '../records/rebuild-search.js';
import { TEMPLATE_NAMES } from '../templates/index.js';
import { createWorkspace, getWorkspace, listWorkspaces } from '../workspaces/workspaces.js';

export const USAGE = `Usage: retainer <command>

Workspaces
  retainer workspace create --name <name> [--slug <slug>] [--template <template>]
  retainer workspace list

API keys
  retainer key create --workspace <slug|id> --name <name> --actor <type:id> --scopes <list>
  retainer key list --workspace <slug|id>
  retainer key revoke <key-id>

Signing keys (runtime database sessions)
  retainer signing-key generate [--id <key-id>]

Search
  retainer search rebuild [--workspace <slug|id>]   Rewrite search documents (all workspaces by default)

Options
  --json    Print machine-readable JSON
  --help    Show this help

Templates: ${TEMPLATE_NAMES.join(', ')}
Actor types: user, integration, agent, system   Scopes: read, write, schema:write, admin
The CLI connects to RETAINER_SURREAL_URL as the system user; there is no admin HTTP API.`;

export type CliIo = {
  /** The backend, with the system credential (operator operations). */
  backend: () => Backend;
  out: (line: string) => void;
  err: (line: string) => void;
};

function required(value: string | undefined, flag: string): string {
  if (!value) throw new AppError(400, 'invalid_request', `missing --${flag}`);
  return value;
}

/**
 * Runs an operator command (ARCHITECTURE.md 7.1). Returns the exit code;
 * never calls process.exit, so tests can drive it in-process.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [group, command, ...rest] = positionals;
  const print = (human: string, data: unknown) =>
    io.out(values.json ? JSON.stringify(data, null, 2) : human);

  if (values.help || !group) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  try {
    switch (`${group} ${command ?? ''}`) {
      case 'signing-key generate': {
        const entry = generateSigningKeyEntry(values.id);
        const id = entry.slice(0, entry.indexOf(':'));
        print(
          [
            `Generated signing key "${id}". Set it as RETAINER_SIGNING_KEY; during a rotation,`,
            'move the old value to RETAINER_SIGNING_PREVIOUS_KEYS until every workspace is upgraded.',
            '',
            entry,
          ].join('\n'),
          { id, key: entry },
        );
        return 0;
      }
      case 'workspace create': {
        const workspace = await createWorkspace(io.backend(), {
          name: required(values.name, 'name'),
          ...(values.slug ? { slug: values.slug } : {}),
          ...(values.template ? { template: values.template } : {}),
        });
        const template =
          workspace.templates.map((t) => t.name).join(', ') || 'none (the first agent picks one)';
        print(
          `Created workspace "${workspace.name}"\n  slug: ${workspace.slug}\n  id: ${workspace.id}\n  template: ${template}`,
          workspace,
        );
        return 0;
      }
      case 'workspace list': {
        const workspaces = await listWorkspaces(io.backend());
        print(
          workspaces.length === 0
            ? 'No workspaces.'
            : workspaces
                .map(
                  (w) =>
                    `${w.slug}\t${w.id}\t${w.name}\t${w.templates.map((t) => t.name).join(',') || '-'}`,
                )
                .join('\n'),
          workspaces,
        );
        return 0;
      }
      case 'key create': {
        const key = await createApiKey(io.backend(), {
          workspace: required(values.workspace, 'workspace'),
          name: required(values.name, 'name'),
          actor: parseActor(required(values.actor, 'actor')),
          scopes: parseScopes(required(values.scopes, 'scopes')),
        });
        print(
          [
            `Created key "${key.name}" (${key.id})`,
            `  actor: ${key.actor.type}:${key.actor.id}`,
            `  scopes: ${key.scopes.join(', ')}`,
            '',
            `  ${key.key}`,
            '',
            'Store it now: it is shown once and only its hash is kept.',
          ].join('\n'),
          key,
        );
        return 0;
      }
      case 'key list': {
        const keys = await listApiKeys(io.backend(), required(values.workspace, 'workspace'));
        print(
          keys
            .map(
              (k) =>
                `${k.id}\t${k.prefix}…\t${k.name}\t${k.actor.type}:${k.actor.id}\t${k.scopes.join(',')}\t${k.revokedAt ? 'revoked' : 'active'}`,
            )
            .join('\n') || 'No keys.',
          keys,
        );
        return 0;
      }
      case 'key revoke': {
        const id = required(rest[0] ?? values.id, 'id');
        const revoked = await revokeApiKey(io.backend(), id);
        print(`Revoked key ${revoked.id}`, revoked);
        return 0;
      }
      case 'search rebuild': {
        // Batched writes under the write protocol: safe while the server runs.
        const backend = io.backend();
        const targets = values.workspace
          ? [await getWorkspace(backend, values.workspace)]
          : await listWorkspaces(backend);
        const rebuilt: { workspace: string; documents: number }[] = [];
        for (const workspace of targets) {
          const documents = await rebuildSearchDocuments(backend, workspace.id);
          rebuilt.push({ workspace: workspace.slug, documents });
        }
        print(
          rebuilt.map((r) => `${r.workspace}\t${r.documents} documents`).join('\n') ||
            'No workspaces.',
          rebuilt,
        );
        return 0;
      }
      default:
        io.err(`Unknown command: retainer ${positionals.join(' ')}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof AppError) {
      io.err(`Error: ${error.message}`);
      if (error.details?.templates)
        io.err(`Templates: ${(error.details.templates as string[]).join(', ')}`);
      return 1;
    }
    if (error instanceof Error && error.name === 'SchemaValidationError') {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      template: { type: 'string' },
      workspace: { type: 'string' },
      actor: { type: 'string' },
      scopes: { type: 'string' },
      id: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
