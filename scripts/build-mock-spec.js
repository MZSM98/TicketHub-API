// Genera mock/tickethub.openapi.json: un solo OpenAPI con todas las rutas que usan las apps cliente,
// para que Prism (que sirve un spec por proceso) las sirva todas en http://localhost:4010/api/v1.
//
// 1. `redocly bundle --dereferenced` resuelve cada contrato (incluido common.yaml) a JSON sin $ref.
// 2. Se juntan las rutas con el prefijo /api/v1 y se descartan /internal/** (el gateway no las enruta).
// 3. El `security` global de cada servicio se copia a sus operaciones que no declaran uno propio.
// Los contratos de contracts/ no se modifican; este archivo es derivado y se regenera con npm run mock:build.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVICES = ['gateway', 'identity', 'catalog', 'inventory', 'purchase', 'ticket'];
const PREFIX = '/api/v1';
const OUTPUT = 'mock/tickethub.openapi.json';
const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);

const workDir = mkdtempSync(join(tmpdir(), 'tickethub-mock-'));
const paths = {};
let bearerAuth;

try {
  for (const service of SERVICES) {
    const bundled = join(workDir, `${service}.json`);
    try {
      execFileSync(
        'npx',
        [
          'redocly',
          'bundle',
          `contracts/${service}.yaml`,
          '--dereferenced',
          '--ext',
          'json',
          '-o',
          bundled,
        ],
        { stdio: 'pipe' },
      );
    } catch (error) {
      process.stderr.write(error.stderr ?? '');
      throw new Error(`No se pudo resolver contracts/${service}.yaml`, { cause: error });
    }
    const spec = JSON.parse(readFileSync(bundled, 'utf8'));
    bearerAuth ??= spec.components?.securitySchemes?.bearerAuth;

    for (const [path, item] of Object.entries(spec.paths)) {
      if (path === '/internal' || path.startsWith('/internal/')) continue;
      const key = `${PREFIX}${path}`;
      if (paths[key]) throw new Error(`Ruta duplicada entre contratos: ${key}`);
      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.has(method) && spec.security && !operation.security) {
          operation.security = spec.security;
        }
      }
      paths[key] = item;
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const mockSpec = {
  openapi: '3.0.3',
  info: {
    title: 'TicketHub API (mock)',
    version: '1.0.0',
    description:
      'Generado por scripts/build-mock-spec.js a partir de contracts/*.yaml. No editar a mano. ' +
      'Incluye solo las rutas que usan las apps cliente (sin /internal/**).',
  },
  servers: [{ url: 'http://localhost:4010', description: 'Prism mock' }],
  paths,
  components: { securitySchemes: { bearerAuth } },
};

writeFileSync(OUTPUT, `${JSON.stringify(mockSpec, null, 2)}\n`);
console.log(`${OUTPUT}: ${Object.keys(paths).length} rutas`);
