-- InventoryService: zonas, asientos y reservas temporales.
-- Contrato: contracts/inventory.yaml
CREATE DATABASE IF NOT EXISTS tickethub_inventory CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE tickethub_inventory;

CREATE TABLE zones (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id       BIGINT UNSIGNED NOT NULL COMMENT 'events.id de CatalogService',
  name           VARCHAR(80)     NOT NULL,
  type           ENUM('NUMBERED', 'GENERAL') NOT NULL,
  price          DECIMAL(10, 2)  NOT NULL,
  capacity       INT UNSIGNED    NOT NULL,
  reserved_count INT UNSIGNED    NOT NULL DEFAULT 0,
  sold_count     INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_zones_event (event_id),
  CONSTRAINT ck_zones_price CHECK (price >= 0),
  CONSTRAINT ck_zones_capacity CHECK (capacity BETWEEN 1 AND 100000),
  -- Nunca se vende ni se aparta más de la capacidad.
  CONSTRAINT ck_zones_no_oversell CHECK (reserved_count + sold_count <= capacity)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE reservations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL COMMENT 'users.id de IdentityService',
  event_id    BIGINT UNSIGNED NOT NULL COMMENT 'events.id de CatalogService',
  status      ENUM('ACTIVE', 'CONFIRMED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  purchase_id BIGINT UNSIGNED NULL COMMENT 'purchases.id que la confirmó (confirm-sale idempotente)',
  expires_at  DATETIME        NOT NULL COMMENT 'created_at + RESERVATION_TTL_MINUTES',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Una sola reserva ACTIVE por comprador: la columna vale user_id solo si está ACTIVE y es única.
  active_user_id BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'ACTIVE', user_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reservations_active_user (active_user_id),
  UNIQUE KEY uq_reservations_purchase (purchase_id),
  KEY ix_reservations_user (user_id),
  KEY ix_reservations_event (event_id),
  KEY ix_reservations_status_expires (status, expires_at),
  CONSTRAINT ck_reservations_purchase CHECK ((status = 'CONFIRMED') = (purchase_id IS NOT NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Solo zonas NUMBERED. reservation_id apunta a la reserva que lo aparta o lo compró.
CREATE TABLE seats (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  zone_id        BIGINT UNSIGNED NOT NULL,
  row_label      VARCHAR(10)     NOT NULL,
  seat_number    INT UNSIGNED    NOT NULL,
  status         ENUM('AVAILABLE', 'RESERVED', 'SOLD') NOT NULL DEFAULT 'AVAILABLE',
  reservation_id BIGINT UNSIGNED NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_seats_position (zone_id, row_label, seat_number),
  KEY ix_seats_reservation (reservation_id),
  CONSTRAINT fk_seats_zone FOREIGN KEY (zone_id) REFERENCES zones (id) ON DELETE CASCADE,
  CONSTRAINT fk_seats_reservation FOREIGN KEY (reservation_id) REFERENCES reservations (id),
  CONSTRAINT ck_seats_number CHECK (seat_number >= 1),
  -- Un asiento libre no tiene reserva; uno apartado o vendido siempre tiene exactamente una.
  CONSTRAINT ck_seats_status_reservation CHECK ((status = 'AVAILABLE') = (reservation_id IS NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Renglón por asiento (NUMBERED, quantity = 1) o por zona general (seat_id NULL, quantity = n).
CREATE TABLE reservation_items (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reservation_id BIGINT UNSIGNED NOT NULL,
  zone_id        BIGINT UNSIGNED NOT NULL,
  seat_id        BIGINT UNSIGNED NULL,
  quantity       INT UNSIGNED    NOT NULL DEFAULT 1,
  unit_price     DECIMAL(10, 2)  NOT NULL COMMENT 'Precio de la zona al reservar',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reservation_items_seat (reservation_id, seat_id),
  KEY ix_reservation_items_zone (zone_id),
  KEY ix_reservation_items_seat (seat_id),
  CONSTRAINT fk_reservation_items_reservation FOREIGN KEY (reservation_id) REFERENCES reservations (id) ON DELETE CASCADE,
  CONSTRAINT fk_reservation_items_zone FOREIGN KEY (zone_id) REFERENCES zones (id) ON DELETE CASCADE,
  CONSTRAINT fk_reservation_items_seat FOREIGN KEY (seat_id) REFERENCES seats (id) ON DELETE CASCADE,
  CONSTRAINT ck_reservation_items_quantity CHECK (quantity BETWEEN 1 AND 10),
  CONSTRAINT ck_reservation_items_price CHECK (unit_price >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
