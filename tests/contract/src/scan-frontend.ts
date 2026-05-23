// Static scan of apps/web for `apiFetch(path, { query, method })` call sites.
//
// We parse with regexes + small balanced-bracket scanners rather than the TS
// AST to keep the package dependency surface tiny (no ts-morph). The web
// client's signature is fixed (`apiFetch<T>(path, options?)`, see
// apps/web/src/lib/api-client.ts), so the shapes we need (string/template path,
// `method:`, `query: { ... }`) are reliably matched. Anything we cannot
// statically resolve is reported in `unresolved` rather than silently dropped.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { collectFiles } from './walk.js';
import { REPO_ROOT, WEB_SRC_DIRS } from './paths.js';

export interface FeCall {
  file: string; // repo-relative
  line: number;
  /** Path template with `${...}` segments normalised to `{param}`. */
  pathTemplate: string;
  method: string; // GET | POST | PATCH | PUT | DELETE
  /** Static query keys we could extract (may be empty). */
  queryKeys: string[];
  /** Static request-body keys for POST/PATCH (best-effort; may be empty). */
  bodyKeys: string[];
  rawPathArg: string;
}

export interface UnresolvedCall {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

export interface FrontendScan {
  calls: FeCall[];
  unresolved: UnresolvedCall[];
}

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

// The fetch wrapper itself defines `apiFetch(path: string, ...)`; it is infra,
// not an endpoint consumer. Skip it so its definition is not mis-scanned.
const SKIP_FILES = ['api-client.ts'];

/** Normalise a JS template/string path literal to an OpenAPI-style template. */
function normalisePath(raw: string): string {
  // `${params.projectId}` / `${id}` / `${activeId}` -> `{param}`.
  // FE paths never carry a trailing slash, so we only collapse interpolations.
  return raw.replace(/\$\{[^}]+\}/g, '{param}');
}

/** Normalise an OpenAPI path (`/v1/users/{user_id}`) to the same template. */
export function normaliseSpecPath(p: string): string {
  return p.replace(/\{[^}]+\}/g, '{param}');
}

/**
 * From `text[from]` (expected to be whitespace then optionally `<...>` then
 * `(`), skip an optional balanced `<...>` generic and whitespace, returning the
 * index of the opening `(`, or -1 if the next non-generic token is not `(`.
 */
function findOpenParen(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === '<') {
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === '<') depth++;
      else if (text[i] === '>') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < text.length && /\s/.test(text[i]!)) i++;
  }
  return text[i] === '(' ? i : -1;
}

/**
 * Find the first balanced `{ ... }` object literal that follows `key:` within
 * `text`. Returns the inner body, or null.
 */
function extractObjectAfterKey(text: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g');
  const m = re.exec(text);
  if (!m) return null;
  let depth = 0;
  let start = -1;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return null;
}

/** Extract the top-level keys of an object-literal body (one nesting level). */
function topLevelKeys(objBody: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  const len = objBody.length;
  let atKeyPos = true; // we are at a position where a key may start
  while (i < len) {
    const ch = objBody[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      atKeyPos = false;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (ch === ',' && depth === 0) {
      atKeyPos = true;
      i++;
      continue;
    }
    if (depth === 0 && atKeyPos) {
      const m = /^[\s\n]*([A-Za-z_$][\w$]*)\s*:/.exec(objBody.slice(i));
      const shorthand = /^[\s\n]*([A-Za-z_$][\w$]*)\s*(,|$)/.exec(objBody.slice(i));
      if (m) {
        keys.push(m[1]!);
        i += m[0].length;
        atKeyPos = false;
        continue;
      }
      if (shorthand) {
        keys.push(shorthand[1]!);
        i += shorthand[1]!.length;
        atKeyPos = false;
        continue;
      }
    }
    i++;
  }
  return keys;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

export function scanFrontend(): FrontendScan {
  const files = collectFiles(WEB_SRC_DIRS, ['.ts', '.tsx']).filter(
    (f) => !SKIP_FILES.some((s) => f.endsWith(s)),
  );
  const calls: FeCall[] = [];
  const unresolved: UnresolvedCall[] = [];

  // Match the `apiFetch` identifier (word-boundary so `xapiFetch` won't match);
  // the optional <generic> + ( is handled by findOpenParen so nested generics
  // like `<Paginated<FinancialProjectRow>>` are tolerated.
  const idRe = /\bapiFetch\b/g;

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(text)) !== null) {
      const callStart = m.index;
      const parenStart = findOpenParen(text, m.index + m[0].length);
      if (parenStart === -1) continue; // an import or a non-call reference

      // Find the balanced end of the call args.
      let depth = 0;
      let end = -1;
      for (let i = parenStart; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;
      const argText = text.slice(parenStart + 1, end);
      const line = lineAt(text, callStart);

      // First argument: the path. Accept '...' / "..." / `...`.
      const pathMatch = /^\s*(['"`])([^'"`]*)\1/.exec(argText);
      if (!pathMatch) {
        unresolved.push({
          file: rel,
          line,
          reason: 'path argument is not a static string/template literal',
          snippet: argText.slice(0, 80).replace(/\s+/g, ' '),
        });
        continue;
      }
      const rawPathArg = pathMatch[2]!;
      if (!rawPathArg.startsWith('/v1/')) {
        // Not an API call we model (or a relative continuation) — record it.
        unresolved.push({
          file: rel,
          line,
          reason: `path "${rawPathArg}" does not start with /v1/`,
          snippet: rawPathArg,
        });
        continue;
      }
      const pathTemplate = normalisePath(rawPathArg);

      // Method.
      const methodMatch = /method\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(argText);
      const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'GET';
      if (!METHODS.includes(method)) {
        unresolved.push({
          file: rel,
          line,
          reason: `unrecognised method "${method}"`,
          snippet: argText.slice(0, 80).replace(/\s+/g, ' '),
        });
      }

      // Query keys.
      const queryBody = extractObjectAfterKey(argText, 'query');
      const queryKeys = queryBody ? topLevelKeys(queryBody) : [];

      // Body keys (best-effort; only when body is an inline object literal).
      const bodyBody = extractObjectAfterKey(argText, 'body');
      const bodyKeys = bodyBody ? topLevelKeys(bodyBody) : [];

      calls.push({
        file: rel,
        line,
        pathTemplate,
        method,
        queryKeys,
        bodyKeys,
        rawPathArg,
      });
    }
  }

  return { calls, unresolved };
}
