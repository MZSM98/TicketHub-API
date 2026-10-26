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

## Calidad de código

```bash
npm install
npm run lint
npm run format:check
```
