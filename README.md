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
npm install && npm run mock               # con Node 20 o 24, regenera el archivo y arranca Prism
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
- El gateway y cada servicio limitan el cuerpo a 100 KB y responden 413 `PAYLOAD_TOO_LARGE`. El gateway lo rechaza por `Content-Length` sin leer el cuerpo y, si llega chunked, cuenta los bytes y corta al pasar el límite (responde primero y descarta hasta 16 MB o 2 s más para que el cliente alcance a leer el 413; después cierra su lado con FIN y destruye el socket 5 s más tarde, nunca antes de terminar de escribir el 413). Las subidas `multipart/form-data` (póster) no pasan por este límite; CatalogService aplica su tope de 5 MB.
- El gateway corta peticiones lentas: `GATEWAY_HEADERS_TIMEOUT_SECONDS` (15 s por omisión) para recibir los headers y `GATEWAY_REQUEST_TIMEOUT_SECONDS` (60 s por omisión) para recibir la petición completa, cuerpo incluido (Node revisa cada segundo). Al vencer cualquiera de los dos responde 408 en JSON (`{"code":"REQUEST_TIMEOUT","message":"La petición tardó demasiado en llegar completa; intente de nuevo"}`, `Content-Type: application/json`, `Connection: close`), deja de leer tras unos segundos y cierra la conexión con FIN, igual que con el 413, para que el cliente alcance a leer la respuesta. Pasa también con headers incompletos. Con 60 s, un póster de 4.9 MB (el tope de 5 MB) solo llega completo si la subida va a más de ~85 KB/s (≈0.7 Mbps, una conexión 3G mala); por debajo de eso el gateway lo corta con 408. 30 s exigiría el doble. Antes valían los 300 s de Node y un cuerpo lento mantenía la conexión abierta más de 70 s.

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
npm test   # levanta un stack aparte (-p tickethub-test-<pid>-<epoch>, o TEST_COMPOSE_PROJECT), crea el admin, corre tests/ y lo borra
```

Cada respuesta se compara contra el schema de su contrato (`tests/contract.js`), incluido que no traiga campos que el contrato no define.

CatalogService llama a InventoryService para publicar un evento (al menos una zona, `GET /internal/zones?eventId=`) y para borrar un DRAFT (`DELETE /internal/events/{eventId}/zones`), y a PurchaseService para las ventas del resumen CU-16 (`GET /internal/stats/sales`). En el stack de pruebas, `docker-compose.test.yml` apunta `catalog-service` y `purchase-service` a `tests/fakes.js`. El fake reenvía las llamadas de zonas y de ventas a los servicios reales, permite simular que no responden, y hace de Stripe y de TicketService falsos. Las pruebas nunca llaman al Stripe real.

`docker-compose.test.yml` también levanta dos copias de InventoryService con reservas de 3 segundos (`RESERVATION_TTL_MINUTES=0.05`): `inventory-sweep`, con limpieza cada segundo, e `inventory-lazy`, sin limpieza periódica. Las pruebas de vencimiento reservan a través de ellas. `npm test` (`scripts/test.sh`) usa su propio proyecto de Compose sin puertos publicados, con nombre único por corrida (`tickethub-test-<pid>-<epoch>`, o el valor de `TEST_COMPOSE_PROJECT`), así que no toca el stack de desarrollo y dos corridas pueden ir a la vez; al terminar, o si se interrumpe, borra ese mismo proyecto con `down -v`. La prueba de concurrencia manda 50 reservas simultáneas por el gateway al mismo asiento y a una zona general, e imprime el resultado.

## CatalogService

Recintos, eventos, personal asignado a eventos y el resumen global (CU-03, CU-04, CU-12, CU-16), según `contracts/catalog.yaml`:

- Recintos sin dueño: ORGANIZER y ADMIN los crean y editan; solo ADMIN los borra, y no si algún evento los usa (409 `VENUE_IN_USE`, lo garantiza la llave foránea).
- Eventos: solo ORGANIZER crea; se crean en DRAFT con el organizador del token. Editar, borrar, cambiar estado, el póster y el personal son solo del organizador dueño (403 `NOT_EVENT_OWNER`). Transiciones: DRAFT -> PUBLISHED, DRAFT -> CANCELLED y PUBLISHED -> CANCELLED.
- Personal: el organizador solo asigna usuarios STAFF activos con `employerId` igual a él (se consulta IdentityService); asignar dos veces responde 200.
- Borrar un evento DRAFT borra primero sus zonas en InventoryService. Si Inventory no responde, el evento no se borra y la respuesta es 503, para no dejar zonas sin evento; se puede reintentar.
- Póster: JPG o PNG de hasta 5 MB en `multipart/form-data` (campo `file`). El tipo se revisa por los primeros bytes del archivo, no por el nombre. Se guarda en MinIO, en el bucket `MINIO_BUCKET_POSTERS`, y MySQL guarda solo `poster_key`. Al reemplazarlo o borrar el evento se borra el archivo anterior. Un evento CANCELLED no acepta póster nuevo (409 `INVALID_EVENT_STATE`). `GET /events/{eventId}/poster` sigue las mismas reglas de visibilidad que el evento (404 DRAFT, 410 CANCELLED) y responde 503 si MinIO no responde.

## InventoryService

Zonas, asientos, disponibilidad y reservas (CU-05 a CU-07), según `contracts/inventory.yaml`:

- Zonas: el organizador dueño del evento las crea, edita y borra (se consulta CatalogService en `/internal/events/{id}`). El precio es por zona. El tipo (NUMBERED o GENERAL) no cambia después de crear la zona (409 `ZONE_TYPE_CHANGE`). La capacidad no baja de lo reservado más lo vendido (409 `CAPACITY_BELOW_COMMITTED`). Una zona con reservas o ventas no se borra ni regenera su plano (409 `ZONE_HAS_SALES`). Cambiar la capacidad de una zona NUMBERED sin reservas borra sus asientos, y hay que volver a generar el plano. En un evento CANCELLED no se crean ni editan zonas.
- Asientos: `GET /zones/{zoneId}/seats` es público con la misma visibilidad que la disponibilidad: 404 `ZONE_NOT_FOUND` si el evento es DRAFT y 410 `EVENT_NOT_AVAILABLE` si está CANCELLED o ya empezó. `POST /zones/{zoneId}/seats` reemplaza el plano completo. La suma de `seatCount` debe ser igual a la capacidad (400 `SEAT_COUNT_MISMATCH`).
- Reservas: solo BUYER, hasta `MAX_TICKETS_PER_RESERVATION` boletos (entero de 1 a 10; fuera de ese rango InventoryService no arranca) (400 `TOO_MANY_TICKETS`), una reserva ACTIVE por comprador (la garantiza el índice único `uq_reservations_active_user`), todo o nada. En una transacción se bloquean los asientos con `SELECT ... FOR UPDATE` y las zonas generales se descuentan con un `UPDATE` condicionado a la capacidad, así que dos compradores no obtienen el mismo asiento ni una zona se sobrevende (`ck_zones_no_oversell` es la última barrera). Cada renglón guarda su `unit_price` y la reserva confirmada guarda `purchase_id`.
- Vencimiento: la reserva dura `RESERVATION_TTL_MINUTES` desde su creación y `secondsRemaining` lo calcula el servidor. Una reserva vencida se marca EXPIRED y libera sus lugares en cuanto alguien la lee o la usa, y antes de mostrar disponibilidad, mapa de asientos o crear una reserva. Además, cada `RESERVATION_SWEEP_SECONDS` (60 por omisión, 0 lo apaga) el servicio libera las vencidas. Varias instancias pueden hacerlo a la vez porque cada una toma filas distintas con `FOR UPDATE SKIP LOCKED`.
- Toda operación que consulta a CatalogService (dueño del evento o visibilidad) responde 503 `SERVICE_UNAVAILABLE` si Catalog no responde.
- Internos para PurchaseService: `confirm-sale` (idempotente con el mismo `purchaseId`) y `release`.

## PurchaseService

Compras, historial y ventas (CU-08, CU-09, CU-13), según `contracts/purchase.yaml`:

- `POST /purchases` (BUYER dueño de la reserva): consulta la reserva en InventoryService, autoriza el total de la reserva con captura manual (nunca un monto del cliente), confirma la venta (`confirm-sale`), captura el pago, guarda la compra con sus renglones (`purchase_items`, con el precio pagado) y pide los boletos a TicketService (`POST /internal/tickets/issue`). Solo recibe `paymentMethodToken`, nunca datos de tarjeta.
- Pagos: el módulo `src/payments` elige el proveedor con `PAYMENT_PROVIDER`. El de Stripe llama a la API REST con `fetch` (form-encoded) usando `STRIPE_SECRET_KEY` (solo `sk_test_`; una `sk_live_` impide arrancar), `STRIPE_API_BASE` y `STRIPE_TIMEOUT_MS`.
- Un renglón por reserva (`uq_purchases_reservation`). Cada solicitud toma un reclamo corto sobre ese renglón (`claim_token`, `claimed_until`); ninguna llamada a Stripe o a Inventory ocurre dentro de una transacción. Las solicitudes simultáneas esperan su turno y, si la primera pagó, reciben 409 `RESERVATION_ALREADY_PAID`.
- Cada intento se guarda en `payment_attempts` como PENDING antes de llamar a Stripe, con la llave de idempotencia `tickethub-reservation-{reserva}-attempt-{n}` (sin el token, así que un reintento con otra tarjeta no puede crear un segundo cargo). El id del PaymentIntent se guarda en cuanto llega. Si un intento quedó PENDING (por ejemplo, Stripe no respondió a tiempo), el siguiente reintento primero repite esa misma solicitud con la misma llave (Stripe la respeta 24 h); si estaba aprobada, termina la compra con ella. El `Idempotency-Key` que mande el cliente se ignora.
- Un barrido cada `PAYMENT_SWEEP_SECONDS` concilia intentos sin reclamo que llevan más de `PAYMENT_RECONCILE_AFTER_SECONDS` sin cambios: resuelve los PENDING, captura los AUTHORIZED cuya venta ya se confirmó, cancela las autorizaciones huérfanas y reintenta cancelaciones y reembolsos fallidos (CANCEL_PENDING, REFUND_PENDING). Cada cancelación, reembolso o liberación fallida suma `recovery_attempts`; al llegar a `PAYMENT_RECOVERY_MAX_ATTEMPTS` (20 por omisión, unas 40 min con los valores por omisión) el intento queda `RECOVERY_FAILED`, el barrido deja de tocarlo y se registra una línea `ALERTA:` en el log para revisión manual. `GET /internal/reservations/{reservationId}/payment-attempts` muestra el estado de cada intento. Si Stripe responde 404 `resource_missing` al cancelar, el PaymentIntent no existe: no hay cargo, se liberan los asientos y el intento queda CANCELED. El 402 solo dice que los asientos fueron liberados cuando Inventory ya los liberó.
- Rechazos: cada uno suma `failed_attempts` y responde 402 `PAYMENT_DECLINED` con `attemptsRemaining`. Al llegar a `PAYMENT_MAX_ATTEMPTS` se libera la reserva (`release`) y la respuesta es 402 `PAYMENT_ATTEMPTS_EXHAUSTED`. Si Stripe no responde: 503 `PAYMENT_GATEWAY_UNAVAILABLE`. Si responde algo inesperado: 502 `PAYMENT_GATEWAY_ERROR`. En los dos casos no cuenta como intento.
- Si la venta no se puede confirmar después de autorizar (por ejemplo, la reserva venció), se cancela la autorización (o se reembolsa si ya estaba capturada) y la respuesta es 410 o 409 según el caso. Si la cancelación falla, el barrido la reintenta.
- Si TicketService falla, la compra queda PAID con `ticketIssuance: PENDING` en la base de datos (`purchases.ticket_issuance`) y se reintenta cada `TICKET_RETRY_SECONDS`, aunque el servicio se reinicie.
- `byZone[].revenue` de CU-13 sale de `purchase_items` (el precio pagado), así que no cambia si después se edita el precio de la zona.
- Si la captura falla después de confirmar la venta por una causa transitoria (red, timeout, 5xx, 429, respuesta no JSON), el pago no se deshace: el cliente recibe 503 y su reintento o el barrido repiten la captura con la misma llave hasta lograrla. Si Stripe la rechaza de forma definitiva (4xx `card_error` o `invalid_request_error`), el intento pasa a `CAPTURE_FAILED`, se cancela la autorización en Stripe (`/cancel` con llave idempotente) y se deshace la venta con `POST /internal/reservations/{id}/revoke-sale` (asientos a AVAILABLE, baja `soldCount`, reserva CANCELLED). Al terminar ambos pasos el intento queda `CANCELED` y la compra DECLINED con un fallo más; si alguno falla, el intento sigue `CAPTURE_FAILED` y el barrido lo reintenta. El cliente recibe 402 `PAYMENT_ATTEMPTS_EXHAUSTED` con `attemptsRemaining: 0`, también en reintentos posteriores.
- Un 409 `idempotency_key_in_use` de Stripe significa que la solicitud original sigue en curso: el intento queda PENDING y la respuesta es 503. Un 400 `idempotency_error` no se reintenta: el intento pasa a CANCEL_PENDING, se busca su PaymentIntent en Stripe por `metadata` (`reservation_id` y `attempt`) y, si existe, se cancela; si no existe, el intento queda `FAILED`. Si la búsqueda falla, el barrido la repite.
- El reclamo dura 5 timeouts de Stripe + 2 internos + 10 s (`PAYMENT_CLAIM_SECONDS` lo reemplaza, solo para pruebas; debe ser un entero mayor que el timeout más largo entre `STRIPE_TIMEOUT_MS` e `INTERNAL_TIMEOUT_MS`, o el servicio no arranca) y toda escritura de estado exige que el reclamo siga vigente.
- Los boletos pendientes se reintentan con backoff exponencial (`TICKET_RETRY_BACKOFF_SECONDS`, tope `TICKET_RETRY_MAX_SECONDS`, exponente acotado a 30 para no desbordar MySQL) en lotes de `TICKET_RETRY_BATCH`, ordenados por el próximo reintento. Tras `TICKET_RETRY_MAX_ATTEMPTS` (50 por defecto) la emisión queda `ticket_issuance = FAILED`, se registra en el log y ya no se reintenta; la respuesta de la API sigue usando solo ISSUED o PENDING.
- El esquema vive en `db/init/*.sql` y solo se aplica cuando el volumen de MySQL está vacío; no hay herramienta de migraciones. Después de cambiar un `.sql`, recrea la base con `docker compose down -v` y `docker compose up -d --build` (borra los datos locales).

Para probar contra Stripe en modo prueba, pon en `.env` `STRIPE_SECRET_KEY` con tu llave `sk_test_...` y `STRIPE_API_BASE=https://api.stripe.com`, levanta el stack normal (sin `docker-compose.test.yml`) y paga una reserva con `pm_card_visa` o `pm_card_chargeDeclined`.

## URLs públicas por host

Las URLs absolutas que devuelve la API (hoy `posterUrl` de CatalogService) se arman con el host con el que el cliente llamó al gateway, así la app de escritorio (`localhost`), el emulador de Android (`10.0.2.2`) y un teléfono en la red local (IP LAN) funcionan a la vez contra el mismo stack. El gateway borra `Forwarded`, `X-Forwarded-*` y `X-Real-IP` que mande el cliente y pone `X-Forwarded-Host` (el `Host` de la petición), `X-Forwarded-Proto` (`http` o `https`) y `X-Tickethub-Gateway` con `GATEWAY_FORWARD_SECRET`. El servicio solo usa esas cabeceras si el secreto coincide, el host es un nombre o IP con puerto opcional (sin ruta, usuario ni espacios) y, si `PUBLIC_HOSTS_ALLOWED` tiene valores (nombres separados por comas, sin puerto), el nombre está en la lista. En cualquier otro caso, incluida una llamada directa al servicio, se usa `PUBLIC_BASE_URL`.

- **`PUBLIC_HOSTS_ALLOWED`**: nombres sin puerto (`localhost`, `api.midominio.com`) y rangos CIDR IPv4 o IPv6 (`192.168.0.0/16`, `10.0.0.0/8`, `fd00::/8`), separados por comas. El puerto del Host se conserva en la URL. Un rango mal escrito, un prefijo con ceros a la izquierda (`10.0.0.0/08`), una entrada con puerto (`192.168.1.5:8080`) o un rango que toca IPv4 mapeado en IPv6 (`::/0`, `::ffff:0:0/96`) impiden que CatalogService arranque. Un Host como `[::ffff:192.168.1.1]` no cuenta como `192.168.1.1`: se usa `PUBLIC_BASE_URL`. Vacío refleja cualquier Host válido: sirve en tu máquina, pero en cualquier despliegue fuera de local llénalo con tus dominios y rangos.
- **`GATEWAY_FORWARD_SECRET`** solo viaja a CatalogService, el único que lo usa.
- **Túnel HTTPS (cloudflared, ngrok) con `TRUST_PROXY`**: detrás del túnel el gateway recibe HTTP y por defecto arma `http://`. `TRUST_PROXY` lista IPs o rangos CIDR de proxies de confianza; solo si la conexión llega desde uno de ellos el gateway toma su `X-Forwarded-Proto` (solo `http` o `https`) y su `X-Forwarded-Host`. A cualquier otro cliente se le siguen borrando esas cabeceras. Vacío: no se confía en nadie. Entradas con ceros a la izquierda (`10.0.0.0/08`), con puerto, `::/0` o rangos IPv4 mapeados en IPv6 (`::ffff:0:0/96` y sus subrangos) impiden arrancar el gateway; para confiar en todo IPv4 usa `0.0.0.0/0`.
  - **Opción por omisión: el túnel en un contenedor con IP fija.** `docker-compose.tunnel.yml` agrega la red `tunnel` (`TUNNEL_SUBNET`, por omisión `172.30.250.0/24`), conecta el gateway a ella, levanta `cloudflared` con la IP fija `TUNNEL_PROXY_IP` (por omisión `172.30.250.10`) y pone esa IP en `TRUST_PROXY`. Usa un túnel rápido de trycloudflare, sin cuentas ni secretos en el repo; la URL pública sale en `docker compose logs cloudflared`:

    ```bash
    docker compose -f docker-compose.yml -f docker-compose.tunnel.yml --profile tunnel up -d
    ```

    Con ngrok es lo mismo: un contenedor `ngrok/ngrok http gateway:8080` con IP fija en esa red y `NGROK_AUTHTOKEN` en tu `.env` (nunca en el repo).

  - **No confíes en la IP de la puerta de enlace del bridge** (`172.17.0.1`, `172.18.0.1`, etc.). Con `docker-proxy` (el proxy de puertos de Docker, activo por omisión), toda petición al puerto publicado, desde `127.0.0.1`, desde la LAN o desde contenedores del bridge por omisión que entran por `172.17.0.1`, llega al gateway con esa misma IP. Confiar en ella es confiar en todos esos clientes, que podrían mandar `X-Forwarded-Proto` y `X-Forwarded-Host` falsos. En Docker Desktop (macOS y Windows) siempre pasa así, porque todo el tráfico publicado entra por su VM.
  - **Qué valor se toma.** cloudflared deja `Host` con el hostname público y Cloudflare reemplaza `X-Forwarded-Proto` con el protocolo real del visitante; `X-Forwarded-Host` solo lo pone (reemplazándolo) si configuras `httpHostHeader`, y si no lo configuras deja pasar el que mandó el cliente. ngrok agrega su valor al final de `X-Forwarded-Proto` (y de `X-Forwarded-For`) si ya venía uno, y en `X-Forwarded-Host` reenvía el del cliente o, si no hay, el `Host`. Por eso el gateway toma el **último** valor de cada lista separada por comas (el que agregó el proxy de confianza) y, si el `X-Forwarded-Host` que queda no es un host válido (con ruta, usuario, espacios o puerto fuera de rango), usa el `Host`. Como ambos túneles pueden dejar pasar un `X-Forwarded-Host` del cliente, `docker-compose.tunnel.yml` pone `TRUST_PROXY_HOST=false`: de cloudflared solo se toma el protocolo y el host sale del `Host`, que Cloudflare enruta y el cliente no puede cambiar. Con ngrok u otro proxy que sí ponga `X-Forwarded-Host` deja `TRUST_PROXY_HOST=true` (valor por omisión) y llena `PUBLIC_HOSTS_ALLOWED` con el hostname del túnel. Un valor distinto de `true` o `false` impide que el gateway arranque.
  - Si el túnel corre fuera de Docker contra `localhost:${GATEWAY_HOST_PORT}`, solo podrías confiar en la IP de la puerta de enlace, con el riesgo de arriba. Úsalo solo si el puerto no está expuesto a otros equipos.

## MinIO

Cada servicio entra a MinIO con su propio usuario, limitado a su bucket: CatalogService (`CATALOG_MINIO_ACCESS_KEY`, `CATALOG_MINIO_SECRET_KEY`) solo a `MINIO_BUCKET_POSTERS` y TicketService (`TICKET_MINIO_ACCESS_KEY`, `TICKET_MINIO_SECRET_KEY`) solo a `MINIO_BUCKET_QR`. Ninguno puede ver otros buckets, crear o borrar buckets, ni usar la administración. El usuario root (`MINIO_ROOT_USER`) solo lo usa el contenedor `minio-init`, que al levantar el stack crea los buckets, las políticas y los usuarios (`minio/init.sh`). Se puede volver a ejecutar sin problema, por ejemplo después de cambiar una contraseña en `.env`:

```bash
docker compose run --rm minio-init
```

## Código compartido

`services/common` (`@tickethub/common`) tiene lo que comparten los servicios: errores con el formato de `common.yaml`, validación, autenticación (`JWT_SECRET`, `INTERNAL_TOKEN`) en `@tickethub/common/http`, y el pool de MySQL (`MYSQL_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) en `@tickethub/common/db`. Los Dockerfile de cada servicio copian este paquete junto con el suyo.

## Calidad de código

```bash
npm install
npm run lint
npm run format:check
```
