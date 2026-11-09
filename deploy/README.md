# Despliegue en 2 VMs con Vagrant

| VM | IP | Servicios | Puertos publicados |
|----|----|-----------|--------------------|
| vm1 | 192.168.56.10 | gateway, identity, catalog, MinIO, Mailpit | 8080 (gateway, reenviado a `127.0.0.1:8080` del host; en `192.168.56.10:8080` solo responde a vm2), 3002 (catalog, solo desde vm2), 8025 y 9001 solo en `127.0.0.1` de la VM |
| vm2 | 192.168.56.11 | inventory, purchase, ticket, MySQL | 3003, 3004, 3005 y 3306, solo desde vm1 |

El firewall (`deploy/firewall.sh`, servicio `tickethub-firewall`) se aplica en la cadena `DOCKER-USER` e `INPUT` y descarta conexiones nuevas a esos puertos que lleguen por la red privada desde cualquier IP distinta de la VM vecina, incluido el host.

El gateway se publica en `0.0.0.0:8080` dentro de vm1 porque el `forwarded_port` de Vagrant entra por la NAT de VirtualBox a la IP `10.0.2.15` de la VM, no a su loopback; ligarlo a `127.0.0.1` rompería `localhost:8080` en el host. Por eso el acceso desde la red privada se corta en el firewall: desde el PC solo funciona `http://localhost:8080`.

## Requisitos

- VirtualBox 7.x y Vagrant 2.4+.
- Un `.env` en la raíz con los secretos. Se genera una vez con `bash deploy/gen-env.sh .env` y nunca se sube al repositorio. Los mismos `JWT_SECRET`, `INTERNAL_TOKEN` y `GATEWAY_FORWARD_SECRET` sirven a las dos VMs porque ambas leen `/vagrant/.env`.
- Stripe queda con `STRIPE_SECRET_KEY=sk_test_replace_me`; para probar pagos pon una clave `sk_test_` propia en `.env` y recarga solo purchase dentro de vm2 (`vagrant ssh vm2`):

  ```bash
  sudo docker compose --env-file /vagrant/.env -f /vagrant/deploy/vm2/docker-compose.yml up -d purchase-service
  ```

  `vagrant provision vm2` también funciona, pero reinicia Docker y reconstruye todo.

- `PAYMENT_NAMESPACE` es obligatorio: si falta o está vacío, purchase no arranca. `gen-env.sh` lo genera, pero un `.env` creado antes de este cambio (como el que reutiliza Vagrant en `/vagrant/.env`) no lo trae. Agrégalo a mano con un valor propio de este despliegue (de 1 a 40 caracteres: a-z, 0-9 y guion), por ejemplo `PAYMENT_NAMESPACE=` seguido de la salida de `openssl rand -hex 8`, y recarga purchase con el comando de arriba.

## Administrador

`vagrant up` crea el ADMIN con `ADMIN_EMAIL` y `ADMIN_PASSWORD` del `.env`. `gen-env.sh` genera esa contraseña al azar; consúltala en el `.env` (no se imprime en ningún log). No es `change-me-admin-password` de `.env.example`, que es la que suponen el tutorial del README principal y una colección de Postman configurada con ese ejemplo (el repositorio no incluye colección); en Postman pon el valor del `.env`. Si el admin ya existe, el aprovisionamiento lo indica y sigue; cualquier otro fallo detiene el aprovisionamiento.

## Uso

```powershell
vagrant up                 # crea vm2 (MySQL) y luego vm1
vagrant status
vagrant ssh vm1            # o vm2
```

Dentro de una VM (`C=vm1` o `C=vm2`):

```bash
C=vm1
alias dc="docker compose --env-file /vagrant/.env -f /vagrant/deploy/$C/docker-compose.yml"
dc ps
dc logs -f gateway
dc restart catalog-service
dc up -d --build
sudo iptables -L TICKETHUB-PEER -n -v
```

Desde el host:

```powershell
curl.exe http://localhost:8080/health
vagrant halt               # apaga las VMs
vagrant destroy -f         # las borra con sus volúmenes
```

Dentro de vm1, si MinIO falla al arrancar, `minio-init` no termina y catalog y el gateway se quedan en `Created`. Arregla MinIO (`dc logs minio`) y repite `dc up -d`.

La RAM se ajusta con `VM1_MEMORY` y `VM2_MEMORY` (MB) antes de `vagrant up`.
