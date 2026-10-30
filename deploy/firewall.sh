#!/usr/bin/env bash
set -euo pipefail

LOCAL_IP="$1"
PEER_IP="$2"
PORTS="$3"
CHAIN=TICKETHUB-PEER

IFACE=$(ip -o -4 addr show | awk -v ip="$LOCAL_IP" '{split($4,a,"/"); if (a[1]==ip) print $2}')
if [ -z "$IFACE" ]; then
  echo "No se encontró la interfaz con IP $LOCAL_IP" >&2
  exit 1
fi

iptables -N DOCKER-USER 2>/dev/null || true
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -i "$IFACE" -s "$PEER_IP" -j RETURN
iptables -A "$CHAIN" -i "$IFACE" -p tcp -m conntrack --ctstate NEW -m conntrack --ctorigdst "$LOCAL_IP" -m multiport --dports "$PORTS" -j DROP
iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"

iptables -C INPUT -i "$IFACE" -j "$CHAIN" 2>/dev/null || iptables -I INPUT 1 -i "$IFACE" -j "$CHAIN"

echo "Firewall aplicado en $IFACE: puertos $PORTS solo desde $PEER_IP"
