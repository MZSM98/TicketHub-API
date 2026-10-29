-- PurchaseService: cobros (proveedor intercambiable) e historial de compras.
-- Contrato: contracts/purchase.yaml
CREATE DATABASE IF NOT EXISTS tickethub_purchase CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE tickethub_purchase;

-- Un renglón por reserva: un reintento tras un rechazo actualiza el mismo renglón,
-- y reservation_id único impide cobrar dos veces la misma reserva.
CREATE TABLE purchases (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reservation_id    BIGINT UNSIGNED NOT NULL COMMENT 'reservations.id de InventoryService',
  user_id           BIGINT UNSIGNED NOT NULL COMMENT 'users.id de IdentityService',
  event_id          BIGINT UNSIGNED NOT NULL COMMENT 'events.id de CatalogService (copiado de la reserva)',
  total             DECIMAL(10, 2)  NOT NULL,
  currency          ENUM('MXN')     NOT NULL DEFAULT 'MXN',
  payment_provider  VARCHAR(40)     NOT NULL COMMENT 'Valor de PAYMENT_PROVIDER, p. ej. stripe',
  payment_reference VARCHAR(255)    NULL COMMENT 'Id del cargo en el proveedor',
  status            ENUM('PAID', 'DECLINED') NOT NULL,
  failed_attempts   TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Máximo PAYMENT_MAX_ATTEMPTS (3)',
  ticket_issuance   ENUM('PENDING', 'ISSUED') NULL,
  ticket_ids        JSON            NULL,
  ticket_attempts   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ticket_next_retry_at DATETIME(3)  NULL,
  claim_token       CHAR(36)        NULL,
  claimed_until     DATETIME(3)     NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchases_reservation (reservation_id),
  KEY ix_purchases_user (user_id, created_at),
  KEY ix_purchases_event (event_id, status, created_at),
  KEY ix_purchases_reference (payment_provider, payment_reference),
  KEY ix_purchases_ticket_retry (ticket_issuance, ticket_next_retry_at),
  CONSTRAINT ck_purchases_total CHECK (total >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE purchase_items (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_id BIGINT UNSIGNED NOT NULL,
  zone_id     BIGINT UNSIGNED NOT NULL,
  seat_id     BIGINT UNSIGNED NULL,
  quantity    INT UNSIGNED    NOT NULL,
  unit_price  DECIMAL(10, 2)  NOT NULL,
  item_key    VARCHAR(30) AS (IF(seat_id IS NULL, CONCAT('zone-', zone_id), CONCAT('seat-', seat_id))) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_items_item (purchase_id, item_key),
  KEY ix_purchase_items_zone (zone_id),
  CONSTRAINT fk_purchase_items_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id),
  CONSTRAINT ck_purchase_items_quantity CHECK (quantity > 0),
  CONSTRAINT ck_purchase_items_price CHECK (unit_price >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE payment_attempts (
  id                 BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  purchase_id        BIGINT UNSIGNED  NOT NULL,
  reservation_id     BIGINT UNSIGNED  NOT NULL,
  attempt            TINYINT UNSIGNED NOT NULL,
  idempotency_key    VARCHAR(100)     NOT NULL,
  payment_method     VARCHAR(255)     NOT NULL,
  amount_cents       INT UNSIGNED     NOT NULL,
  currency           ENUM('MXN')      NOT NULL DEFAULT 'MXN',
  provider_reference VARCHAR(255)     NULL,
  status             ENUM('PENDING', 'AUTHORIZED', 'CAPTURED', 'CAPTURE_FAILED', 'DECLINED', 'FAILED', 'CANCEL_PENDING', 'CANCELED', 'REFUND_PENDING', 'REFUNDED') NOT NULL,
  decline_code       VARCHAR(100)     NULL,
  last_error         VARCHAR(255)     NULL,
  created_at         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_attempts_attempt (reservation_id, attempt),
  UNIQUE KEY uq_payment_attempts_key (idempotency_key),
  KEY ix_payment_attempts_status (status, updated_at),
  KEY ix_payment_attempts_purchase (purchase_id),
  CONSTRAINT fk_payment_attempts_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
