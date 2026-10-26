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

## Calidad de código

```bash
npm install
npm run lint
npm run format:check
```
