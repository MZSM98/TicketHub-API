#!/bin/bash
# Crea un usuario de MySQL por servicio con permisos solo sobre su propio esquema.
# Lo ejecuta la imagen mysql:8 una sola vez, cuando el volumen de datos está vacío.
set -euo pipefail

create_user() {
  local user="$1" password="$2" schema="$3"
  mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${schema}\`.* TO '${user}'@'%';
SQL
}

create_user "${IDENTITY_DB_USER}" "${IDENTITY_DB_PASSWORD}" tickethub_identity
create_user "${CATALOG_DB_USER}" "${CATALOG_DB_PASSWORD}" tickethub_catalog
create_user "${INVENTORY_DB_USER}" "${INVENTORY_DB_PASSWORD}" tickethub_inventory
create_user "${PURCHASE_DB_USER}" "${PURCHASE_DB_PASSWORD}" tickethub_purchase
create_user "${TICKET_DB_USER}" "${TICKET_DB_PASSWORD}" tickethub_ticket
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "FLUSH PRIVILEGES;"
