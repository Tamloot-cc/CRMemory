#!/usr/bin/env node
// Keeps the server's modules layered and the MIT packages free of server code.
// ARCHITECTURE.md section 8 describes the layers. Runs as part of `pnpm lint`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'packages/server/src');
const MIT_PACKAGES = ['shared', 'sdk', 'mcp', 'web'];

// Lowest first. A module may import its own layer and the layers before it.
const LAYERS = [
  ['foundation', ['caller', 'config', 'errors', 'log', 'version', 'db', 'http', 'auth', 'schema']],
  ['core', ['idempotency', 'records', 'memory', 'privacy']],
  ['features', ['views', 'comments', 'retrieval', 'reads']],
  ['admin', ['schema-engine', 'templates', 'workspaces']],
  ['interfaces', ['api', 'mcp', 'worker', 'lambda', 'operator']],
  ['entry', ['index', 'cli']],
];
// Events are records, so these modules depend on each other by design.
const MAY_SHARE_A_CYCLE = 'core';

const layerOf = new Map(LAYERS.flatMap(([, modules], i) => modules.map((m) => [m, i])));
const layerName = (module) => LAYERS[layerOf.get(module)][0];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const importsOf = (file) =>
  [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1]);

function resolve(file, specifier) {
  const base = normalize(join(dirname(file), specifier)).replace(/\.js$/, '');
  return [`${base}.ts`, `${base}.tsx`].find(existsSync);
}

/** The module of a server file: its top folder, or its name for a top-level file. */
function moduleOf(file) {
  return relative(SERVER, file)
    .split('/')[0]
    .replace(/\.tsx?$/, '');
}

/** Strongly connected components with more than one node (Tarjan). */
function cycles(graph) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const found = [];
  const visit = (node) => {
    index.set(node, index.size);
    low.set(node, index.get(node));
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (stack.includes(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = stack.splice(stack.indexOf(node));
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return found;
}

const problems = [];
const fileGraph = new Map();
const moduleGraph = new Map();
const edge = (graph, from, to) => {
  if (!graph.has(from)) graph.set(from, new Set());
  graph.get(from).add(to);
};

for (const file of sourceFiles(SERVER)) {
  const from = moduleOf(file);
  const name = relative(ROOT, file);
  if (!layerOf.has(from)) {
    problems.push(`${name}: module "${from}" has no layer in scripts/check-layers.mjs`);
    continue;
  }
  fileGraph.set(file, fileGraph.get(file) ?? new Set());
  for (const specifier of importsOf(file)) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(file, specifier);
    if (!target?.startsWith(SERVER)) continue;
    edge(fileGraph, file, target);
    const to = moduleOf(target);
    if (to === from || !layerOf.has(to)) continue;
    if (layerOf.get(to) > layerOf.get(from)) {
      problems.push(
        `${name}: ${from} (${layerName(from)}) must not import ${to} (${layerName(to)})`,
      );
    }
    const group = (module) =>
      layerName(module) === MAY_SHARE_A_CYCLE ? MAY_SHARE_A_CYCLE : module;
    if (group(from) !== group(to)) edge(moduleGraph, group(from), group(to));
  }
}

for (const cycle of cycles(moduleGraph)) problems.push(`module cycle: ${cycle.join(', ')}`);
for (const cycle of cycles(fileGraph)) {
  problems.push(`file cycle: ${cycle.map((file) => relative(SERVER, file)).join(', ')}`);
}

for (const pkg of MIT_PACKAGES) {
  for (const file of sourceFiles(join(ROOT, 'packages', pkg, 'src'))) {
    for (const specifier of importsOf(file)) {
      const absolute = specifier.startsWith('.') ? normalize(join(dirname(file), specifier)) : '';
      if (
        specifier.startsWith('@retainer/server') ||
        absolute.startsWith(join(ROOT, 'packages/server'))
      ) {
        problems.push(
          `${relative(ROOT, file)}: MIT package imports AGPL server code (${specifier})`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Layer check failed:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Layer check passed: ${fileGraph.size} server files.`);
