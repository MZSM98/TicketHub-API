-- IdentityService: cuentas, roles, personal de organizadores y refresh tokens.
-- Contrato: contracts/identity.yaml
CREATE DATABASE IF NOT EXISTS tickethub_identity CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE tickethub_identity;

CREATE TABLE users (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                 VARCHAR(120)    NOT NULL,
  -- Único también entre cuentas borradas (EMAIL_ALREADY_REGISTERED incluye soft-deleted).
  email                VARCHAR(255)    NOT NULL,
  password_hash        CHAR(60)        NOT NULL COMMENT 'bcrypt',
  role                 ENUM('BUYER', 'STAFF', 'ORGANIZER', 'ADMIN') NOT NULL,
  status               ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  organization_name    VARCHAR(160)    NULL COMMENT 'Solo ORGANIZER (CU-15)',
  employer_id          BIGINT UNSIGNED NULL COMMENT 'Solo STAFF: organizador que lo emplea',
  must_change_password BOOLEAN         NOT NULL DEFAULT FALSE,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at           DATETIME        NULL COMMENT 'Borrado lógico (CU-14)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_role_status (role, status),
  KEY ix_users_employer (employer_id),
  CONSTRAINT fk_users_employer FOREIGN KEY (employer_id) REFERENCES users (id),
  CONSTRAINT ck_users_organization CHECK (organization_name IS NULL OR role = 'ORGANIZER'),
  CONSTRAINT ck_users_employer CHECK ((role = 'STAFF') = (employer_id IS NOT NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Solo se guarda el hash del refresh token (columnas tal como las fija identity.yaml).
CREATE TABLE refresh_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64)        NOT NULL COMMENT 'SHA-256 en hex del token opaco',
  expires_at DATETIME        NOT NULL,
  revoked_at DATETIME        NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_tokens_hash (token_hash),
  KEY ix_refresh_tokens_user (user_id, revoked_at),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
