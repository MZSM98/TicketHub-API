#!/usr/bin/env bash
set -euo pipefail

ROLE="$1"
LOCAL_IP="$2"
PEER_IP="$3"
PORTS="$4"
COMPOSE="docker compose --env-file /vagrant/.env -f /vagrant/deploy/$ROLE/docker-compose.yml"

if [ ! -f /vagrant/.env ]; then
  echo "Falta /vagrant/.env (genéralo con deploy/gen-env.sh)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

mkdir -p /etc/docker
echo '{ "userland-proxy": false }' > /etc/docker/daemon.json
usermod -aG docker vagrant

install -m 0755 /vagrant/deploy/firewall.sh /usr/local/sbin/tickethub-firewall
cat > /etc/systemd/system/tickethub-firewall.service <<UNIT
[Unit]
Description=Restringe los puertos de TicketHub a la VM vecina
Before=docker.service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tickethub-firewall $LOCAL_IP $PEER_IP $PORTS

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable tickethub-firewall.service
systemctl restart tickethub-firewall.service
systemctl restart docker
/usr/local/sbin/tickethub-firewall "$LOCAL_IP" "$PEER_IP" "$PORTS"

if [ "$ROLE" = "vm1" ]; then
  echo "Esperando MySQL en $PEER_IP:3306"
  for i in $(seq 1 120); do
    timeout 2 bash -c "</dev/tcp/$PEER_IP/3306" 2>/dev/null && break
    if [ "$i" = 120 ]; then
      echo "MySQL de $PEER_IP no responde; levanta vm2 primero" >&2
      exit 1
    fi
    sleep 5
  done
fi

$COMPOSE up -d --build

if [ "$ROLE" = "vm1" ]; then
  for i in $(seq 1 60); do
    curl -fs http://127.0.0.1:8080/health >/dev/null 2>&1 && break
    sleep 5
  done
  $COMPOSE exec -T identity-service npm run --silent create-admin
fi

$COMPOSE ps
