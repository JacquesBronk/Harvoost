// Load and index the pinned openapi.yaml.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { resolveSpecPath } from './paths.js';
import { normaliseSpecPath } from './scan-frontend.js';

export interface SpecParam {
  name: string;
  in: string; // query | path | header
  required: boolean;
}

export interface SpecOperation {
  method: string; // GET | POST | ...
  rawPath: string; // /v1/users/{user_id}
  pathTemplate: string; // /v1/users/{param}
  operationId?: string;
  params: SpecParam[]; // merged path-level + operation-level
  /** Resolved 2xx JSON response schema (the success body), or undefined. */
  successSchema?: unknown;
}

export interface LoadedSpec {
  raw: any;
  /** key = `${METHOD} ${pathTemplate}` */
  operations: Map<string, SpecOperation>;
  specPath: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/** Resolve a local `#/components/...` $ref against the document. */
export function deref(doc: any, node: any, seen = new Set<string>()): any {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (seen.has(ref)) return node;
    seen.add(ref);
    const parts = ref.replace(/^#\//, '').split('/');
    let cur = doc;
    for (const p of parts) {
      cur = cur?.[decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~'))];
    }
    return deref(doc, cur, seen);
  }
  return node;
}

function resolveParams(doc: any, pathItem: any, op: any): SpecParam[] {
  const merged: SpecParam[] = [];
  const collect = (arr: any[] | undefined) => {
    for (const p of arr ?? []) {
      const r = deref(doc, p);
      if (r && r.name && r.in) {
        merged.push({ name: r.name, in: r.in, required: !!r.required });
      }
    }
  };
  collect(pathItem.parameters);
  collect(op.parameters);
  return merged;
}

function resolveSuccessSchema(doc: any, op: any): unknown {
  const responses = op.responses ?? {};
  const code = ['200', '201', '202'].find((c) => responses[c]);
  if (!code) return undefined;
  const resp = deref(doc, responses[code]);
  const schema = resp?.content?.['application/json']?.schema;
  return schema ? deref(doc, schema) : undefined;
}

export function loadSpec(): LoadedSpec {
  const specPath = resolveSpecPath();
  const doc = parse(readFileSync(specPath, 'utf8'));
  const operations = new Map<string, SpecOperation>();

  for (const [rawPath, pathItemRaw] of Object.entries<any>(doc.paths ?? {})) {
    const pathItem = pathItemRaw;
    const pathTemplate = normaliseSpecPath(rawPath);
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const key = `${method.toUpperCase()} ${pathTemplate}`;
      operations.set(key, {
        method: method.toUpperCase(),
        rawPath,
        pathTemplate,
        operationId: op.operationId,
        params: resolveParams(doc, pathItem, op),
        successSchema: resolveSuccessSchema(doc, op),
      });
    }
  }

  return { raw: doc, operations, specPath };
}
