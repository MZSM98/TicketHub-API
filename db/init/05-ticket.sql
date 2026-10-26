-- TicketService: boletos digitales con QR firmado y su validación en la entrada.
-- Contrato: contracts/ticket.yaml
CREATE DATABASE IF NOT EXISTS tickethub_ticket CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE tickethub_ticket;

CREATE TABLE tickets (
  id           CHAR(36)        NOT NULL COMMENT 'UUID',
  purchase_id  BIGINT UNSIGNED NOT NULL COMMENT 'purchases.id de PurchaseService',
  user_id      BIGINT UNSIGNED NOT NULL COMMENT 'users.id de IdentityService',
  event_id     BIGINT UNSIGNED NOT NULL COMMENT 'events.id de CatalogService',
  zone_id      BIGINT UNSIGNED NOT NULL COMMENT 'zones.id de InventoryService',
  seat_id      BIGINT UNSIGNED NULL COMMENT 'seats.id de InventoryService; NULL en zona GENERAL',
  signed_token VARCHAR(2048)   NOT NULL COMMENT 'JWS HS256 {tid, eid} que va en el QR',
  qr_key       VARCHAR(255)    NOT NULL COMMENT 'PNG en MinIO',
  status       ENUM('VALID', 'USED', 'CANCELLED') NOT NULL DEFAULT 'VALID',
  used_at      DATETIME        NULL,
  validated_by BIGINT UNSIGNED NULL COMMENT 'users.id (STAFF) que lo escaneó',
  issued_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Un asiento numerado nunca tiene dos boletos (NULL se permite varias veces: zonas generales).
  UNIQUE KEY uq_tickets_seat (seat_id),
  KEY ix_tickets_purchase (purchase_id),
  KEY ix_tickets_user (user_id, issued_at),
  KEY ix_tickets_event (event_id, status),
  CONSTRAINT ck_tickets_used CHECK ((status = 'USED') = (used_at IS NOT NULL AND validated_by IS NOT NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
