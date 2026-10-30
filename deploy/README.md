# Despliegue en 2 VMs con Vagrant

| VM | IP | Servicios | Puertos publicados |
|----|----|-----------|--------------------|
| vm1 | 192.168.56.10 | gateway, identity, catalog, MinIO, Mailpit | 8080 (gateway, reenviado a `127.0.0.1:8080` del host), 3002 (catalog, solo desde vm2), 8025 y 9001 solo en `127.0.0.1` de la VM |
| vm2 | 192.168.56.11 | inventory, purchase, ticket, MySQL | 3003, 3004, 3005 y 3306, solo desde vm1 |

El firewall (`deploy/firewall.sh`, servicio `tickethub-firewall`) se aplica en la cadena `DOCKER-USER` e `INPUT` y descarta conexiones nuevas a esos puertos que lleguen por la red privada desde cualquier IP distinta de la VM vecina, incluido el host.

## Requisitos

- VirtualBox 7.x y Vagrant 2.4+.
- Un `.env` en la raíz con los secretos. Se genera una vez con `bash deploy/gen-env.sh .env` y nunca se sube al repositorio. Los mismos `JWT_SECRET`, `INTERNAL_TOKEN` y `GATEWAY_FORWARD_SECRET` sirven a las dos VMs porque ambas leen `/vagrant/.env`.
- Stripe queda con `STRIPE_SECRET_KEY=sk_test_replace_me`; para probar pagos pon una clave `sk_test_` propia en `.env` y ejecuta `vagrant provision vm2`.

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

La RAM se ajusta con `VM1_MEMORY` y `VM2_MEMORY` (MB) antes de `vagrant up`.
