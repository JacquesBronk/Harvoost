// Pull the declared property names out of a (resolved) OpenAPI schema node,
// flattening allOf and looking through a oneOf/anyOf that contains exactly one
// object branch (the `T | null` idiom used heavily in this spec).
import { deref } from './load-spec.js';

export function objectProps(doc: any, schema: any): Record<string, any> {
  const node = deref(doc, schema);
  if (!node || typeof node !== 'object') return {};

  if (node.type === 'object' || node.properties) {
    const props: Record<string, any> = { ...(node.properties ?? {}) };
    for (const sub of node.allOf ?? []) {
      Object.assign(props, objectProps(doc, sub));
    }
    return props;
  }

  if (Array.isArray(node.allOf)) {
    const props: Record<string, any> = {};
    for (const sub of node.allOf) Object.assign(props, objectProps(doc, sub));
    return props;
  }

  for (const branch of node.oneOf ?? node.anyOf ?? []) {
    const r = deref(doc, branch);
    if (r && (r.type === 'object' || r.properties)) {
      return objectProps(doc, r);
    }
  }

  return {};
}

/**
 * Given a success-response schema and an envelope key, return the property map
 * of the row schema for the requested shape.
 */
export function resolveRowProps(
  doc: any,
  successSchema: any,
  envelopeKey: string,
  shape: 'array-items' | 'object' | 'paginated-data',
): Record<string, any> {
  const top = objectProps(doc, successSchema);

  if (shape === 'object') {
    // The success schema IS the resource (e.g. POST -> CostRate).
    return objectProps(doc, successSchema);
  }

  const envProp = top[envelopeKey];
  if (!envProp) return {};
  const env = deref(doc, envProp);
  if (env?.type === 'array' || env?.items) {
    return objectProps(doc, env.items);
  }
  return objectProps(doc, env);
}
