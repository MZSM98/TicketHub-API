-- CatalogService: recintos, eventos y asignación de personal a eventos.
-- Contrato: contracts/catalog.yaml
CREATE DATABASE IF NOT EXISTS tickethub_catalog CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE tickethub_catalog;

-- Los recintos no tienen dueño: cualquier organizador los edita y solo ADMIN los borra.
CREATE TABLE venues (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(160)    NOT NULL,
  address    VARCHAR(255)    NOT NULL,
  city       VARCHAR(120)    NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_venues_city (city)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organizer_id BIGINT UNSIGNED NOT NULL COMMENT 'users.id de IdentityService (sin FK entre servicios)',
  venue_id     BIGINT UNSIGNED NOT NULL,
  title        VARCHAR(160)    NOT NULL,
  description  TEXT            NOT NULL,
  category     ENUM('CONCERT', 'RECITAL', 'FESTIVAL', 'THEATER', 'SPORTS', 'OTHER') NOT NULL,
  starts_at    DATETIME        NOT NULL COMMENT 'UTC',
  poster_key   VARCHAR(255)    NULL COMMENT 'Objeto en MinIO',
  status       ENUM('DRAFT', 'PUBLISHED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_events_organizer (organizer_id),
  KEY ix_events_status_starts (status, starts_at),
  KEY ix_events_category (category),
  -- RESTRICT: un recinto usado por algún evento no se puede borrar (VENUE_IN_USE).
  CONSTRAINT fk_events_venue FOREIGN KEY (venue_id) REFERENCES venues (id) ON DELETE RESTRICT
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Personal (STAFF) del organizador asignado a sus eventos. La PK hace idempotente la asignación.
CREATE TABLE event_staff (
  event_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL COMMENT 'users.id (STAFF) de IdentityService',
  assigned_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id),
  KEY ix_event_staff_user (user_id),
  CONSTRAINT fk_event_staff_event FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
