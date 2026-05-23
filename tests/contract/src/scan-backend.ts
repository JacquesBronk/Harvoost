// Static scan of apps/api/src for registered NestJS routes.
//
// We compose `@Controller('prefix')` with method decorators (`@Get('sub')`,
// `@Post()`, ...) within the same controller file. Nest path params use
// `:param`; we normalise them to `{param}` to match the spec/FE templates.
// There is no global route prefix in this app (controllers carry the full
// `v1/...` prefix — confirmed across apps/api/src/*/*.controller.ts).
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { collectFiles } from './walk.js';
import { REPO_ROOT, API_SRC_DIR } from './paths.js';

export interface BackendRoute {
  method: string;
  pathTemplate: string; // /v1/... with `{param}`
  file: string;
  controllerPrefix: string;
}

const METHOD_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
};

function joinPath(prefix: string, sub: string): string {
  const a = prefix.replace(/^\/+|\/+$/g, '');
  const b = sub.replace(/^\/+|\/+$/g, '');
  const joined = [a, b].filter(Boolean).join('/');
  return '/' + joined.replace(/:([A-Za-z0-9_]+)/g, '{param}');
}

export function scanBackend(): { routes: BackendRoute[]; routeSet: Set<string> } {
  const files = collectFiles([API_SRC_DIR], ['.ts']).filter((f) =>
    f.endsWith('.controller.ts'),
  );
  const routes: BackendRoute[] = [];

  const controllerRe = /@Controller\(\s*(['"`])([^'"`]*)\1\s*\)/;
  const methodRe = /@(Get|Post|Put|Patch|Delete)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const text = readFileSync(file, 'utf8');
    const ctrl = controllerRe.exec(text);
    if (!ctrl) continue;
    const prefix = ctrl[2]!;

    let m: RegExpExecArray | null;
    methodRe.lastIndex = 0;
    while ((m = methodRe.exec(text)) !== null) {
      const httpMethod = METHOD_DECORATORS[m[1]!];
      const sub = m[3] ?? '';
      if (!httpMethod) continue;
      routes.push({
        method: httpMethod,
        pathTemplate: joinPath(prefix, sub),
        file: rel,
        controllerPrefix: prefix,
      });
    }
  }

  const routeSet = new Set(routes.map((r) => `${r.method} ${r.pathTemplate}`));
  return { routes, routeSet };
}
