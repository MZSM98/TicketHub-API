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

## Autenticación

- `POST /api/v1/auth/login` regresa un `accessToken` (JWT HS256, 1 hora) y un `refreshToken` (opaco, 7 días). Cada `POST /auth/refresh` revoca el refresh enviado y entrega un par nuevo (rotación); en la base solo se guarda el SHA-256 del refresh.
- El gateway revisa la firma y la vigencia del access token en todas las rutas, salvo las públicas de los contratos (`security: []`): login, registro, refresh, logout, catálogo de eventos, disponibilidad y mapa de asientos. En `GET /events/{id}` y en el póster el token es opcional, pero si se envía debe ser válido. El header `Authorization` llega sin cambios al servicio, que revisa el rol y la propiedad del recurso.
- `JWT_SECRET` lo comparten el gateway y los servicios. `/internal/**` no pasa por el gateway; entre servicios se usa el header `X-Internal-Token` con `INTERNAL_TOKEN`.

## Correo (SMTP)

IdentityService manda las credenciales temporales de organizadores (CU-15) y de personal con Nodemailer. En desarrollo usa Mailpit (`SMTP_HOST=mailpit`, `SMTP_PORT=1025`) y los correos se ven en `http://localhost:8025`. Para enviar correos reales con Gmail:

1. Activa la verificación en dos pasos en la cuenta de Google.
2. Crea una contraseña de aplicación en <https://myaccount.google.com/apppasswords>.
3. En `.env`: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=<tu cuenta>`, `SMTP_PASS=<contraseña de aplicación>` y `MAIL_FROM="TicketHub <tu cuenta>"`.

Si el SMTP falla, la cuenta se crea igual y la respuesta trae `credentialsEmailSent: false`.

## Pruebas

Las pruebas de integración usan `node:test` y `fetch`, y llaman a la API a través del gateway. Corren en un contenedor dentro de la red de Docker, así que también pueden llamar a `/internal/**` directamente y leer Mailpit:

```bash
docker compose up -d --build
npm test   # crea el admin de .env si no existe y corre tests/ en el contenedor `tests`
```

Cada respuesta se compara contra el schema de su contrato (`tests/contract.js`), incluido que no traiga campos que el contrato no define.

CatalogService depende de dos servicios que aún no existen: InventoryService (publicar un evento requiere al menos una zona, `GET /internal/zones?eventId=`) y PurchaseService (ventas del resumen CU-16, `GET /internal/stats/sales`). Para probarlo, `npm test` recrea `catalog-service` con `docker-compose.test.yml`, que lo apunta a un Inventory y un Purchase falsos que levanta la suite (`tests/fakes.js`), y al terminar lo regresa a la configuración normal. Fuera de las pruebas, mientras esos servicios no estén implementados, publicar un evento responde 503 y el resumen trae `sales: null` con `"sales"` en `unavailableSections`.

## CatalogService

Recintos, eventos, personal asignado a eventos y el resumen global (CU-03, CU-04, CU-12, CU-16), según `contracts/catalog.yaml`:

- Recintos sin dueño: ORGANIZER y ADMIN los crean y editan; solo ADMIN los borra, y no si algún evento los usa (409 `VENUE_IN_USE`, lo garantiza la llave foránea).
- Eventos: solo ORGANIZER crea; se crean en DRAFT con el organizador del token. Editar, borrar, cambiar estado, el póster y el personal son solo del organizador dueño (403 `NOT_EVENT_OWNER`). Transiciones: DRAFT -> PUBLISHED, DRAFT -> CANCELLED y PUBLISHED -> CANCELLED.
- Personal: el organizador solo asigna usuarios STAFF activos con `employerId` igual a él (se consulta IdentityService); asignar dos veces responde 200.
- Póster: **pendiente**. Subirlo responde 503 y `GET /events/{eventId}/poster` responde 404 `POSTER_NOT_FOUND`, porque falta aprobar un cliente S3 y un parser de `multipart/form-data`.

## Calidad de código

```bash
npm install
npm run lint
npm run format:check
```
