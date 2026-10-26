# TicketHub API

API del Sistema de Boletos (equipo CyberLeek). Node.js + Express con arquitectura orientada a servicios (SOA): un API Gateway y los servicios Identity, Catalog, Inventory, Purchase y Ticket, con MySQL, MinIO y Docker Compose.

Los contratos OpenAPI de cada servicio viven en `contracts/`.

## Estructura

```
contracts/          Contratos OpenAPI (uno por servicio, más gateway y common)
db/init/            Esquema MySQL: un archivo por servicio y usuarios de BD por servicio
services/gateway    API Gateway (puerto 8080): enruta /api/v1/** a cada servicio
services/identity   IdentityService (3001)
services/catalog    CatalogService (3002)
services/inventory  InventoryService (3003)
services/purchase   PurchaseService (3004)
services/ticket     TicketService (3005)
```

## Levantar en local

Requisitos: Docker con Compose v2 y Node 20.

```bash
cp .env.example .env      # cambia las contraseñas de ejemplo
docker compose up -d --build
curl http://localhost:8080/api/v1/health
```

- Solo el gateway queda expuesto (`GATEWAY_HOST_PORT`, 8080 por defecto). Los servicios viven en la red privada `tickethub`.
- MySQL en `127.0.0.1:3306`, consola de MinIO en `http://localhost:9001` y buzón de Mailpit en `http://localhost:8025`.
- Los scripts de `db/init/` solo corren cuando el volumen de MySQL está vacío. Para recrear la base: `docker compose down -v`.

## Primer administrador

No hay datos semilla. El primer ADMIN se crea con un script del IdentityService que lee `ADMIN_NAME`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 8 caracteres) y guarda la contraseña como hash bcrypt (`BCRYPT_ROUNDS`, 10 por defecto):

```bash
docker compose exec identity-service npm run create-admin
```

Toma los valores de `.env`. También puedes pasarlos solo para esa ejecución:

```bash
docker compose exec -e ADMIN_EMAIL=admin@ejemplo.com -e ADMIN_PASSWORD='otra-contraseña' identity-service npm run create-admin
```

- Si el correo ya existe, no cambia nada y termina sin error, así que se puede ejecutar varias veces.
- El administrador queda `ACTIVE` y con `must_change_password = false`, porque la contraseña la eligió quien ejecuta el script; en el contrato ese indicador es solo para contraseñas generadas y enviadas por correo.
- El script nunca imprime la contraseña. Después de crearlo, puedes borrar `ADMIN_PASSWORD` de `.env`.

## Servidor mock (Prism)

Para que las apps móvil y de escritorio avancen sin esperar la implementación, hay un servidor mock con [Prism](https://stoplight.io/open-source/prism) que responde todas las rutas de los contratos con sus ejemplos. Es solo para desarrollo.

**Cómo funciona.** Prism sirve un solo archivo OpenAPI por proceso, así que `scripts/build-mock-spec.js` genera `mock/tickethub.openapi.json` a partir de `contracts/*.yaml`. Para cada contrato hace `redocly bundle --dereferenced`, junta las rutas con el prefijo `/api/v1` y deja fuera `/internal/**`, igual que el gateway. Los contratos no se modifican. El archivo generado se versiona para que se pueda levantar con Docker sin instalar Node. Si cambias un contrato, regenera con `npm run mock:build`; `npm run mock:check` falla si el archivo quedó desactualizado.

**Levantarlo** (cualquiera de las dos opciones):

```bash
docker compose --profile mock up mock     # con Docker, sin Node
npm install && npm run mock               # con Node 20, regenera el archivo y arranca Prism
```

- URL base: `http://localhost:4010/api/v1`, por ejemplo `GET http://localhost:4010/api/v1/events`.
- Emulador de Android: `localhost` es el propio emulador; usa `http://10.0.2.2:4010/api/v1`.
- El servicio `mock` solo se levanta con `--profile mock`; un `docker compose up` normal no lo arranca. El puerto se cambia con `MOCK_HOST_PORT`.
- En un celular físico usa la IP de tu computadora; para eso Prism debe escuchar en todas las interfaces (`npm run mock -- -h 0.0.0.0`).

**Elegir la respuesta.** Por defecto Prism responde el primer código de éxito con el ejemplo del contrato. Las respuestas son fijas: no guardan estado y no dependen de lo que mandes. Para forzar otra respuesta usa el header `Prefer`:

```bash
# Un código específico (usa el primer ejemplo de esa respuesta)
curl -X POST http://localhost:4010/api/v1/reservations \
  -H 'Authorization: Bearer cualquier-cosa' -H 'Content-Type: application/json' \
  -H 'Prefer: code=409' -d '{"eventId":12,"items":[{"seatId":9001}]}'

# Un ejemplo con nombre dentro de ese código
curl ... -H 'Prefer: code=409, example=activeReservation'
curl -X POST http://localhost:4010/api/v1/purchases ... -H 'Prefer: code=402, example=declinedNoAttemptsLeft'
```

Los nombres de los ejemplos (`seatUnavailable`, `activeReservation`, `declinedCanRetry`, etc.) son los que aparecen en `examples:` de cada respuesta en los contratos.

**Validación.** Prism valida cada petición contra el contrato: campos obligatorios, tipos, formatos y parámetros. Si la petición no es válida, responde 400 con el ejemplo de error de esa operación cuando el contrato define un 400 (las que reciben cuerpo, como login, reservas o compras), y 422 cuando no lo define (por ejemplo, `pageSize=500` en un GET de listado). El detalle exacto viene en el header `sl-violations` (en el 422 también en el campo `validation` del cuerpo), por ejemplo `Request body must have required property 'items'`. El cuerpo de la respuesta es el ejemplo fijo del contrato y puede no coincidir con tu error.

**Autenticación.** En las rutas protegidas, Prism solo revisa que venga el header `Authorization: Bearer ...`; si falta, responde 401. El token no se verifica, así que sirve cualquier texto, y el `accessToken` que regresa el login del mock no es un JWT real. Los roles y la propiedad de los recursos tampoco se revisan.

## Calidad de código

```bash
npm install
npm run lint
npm run format:check
```
