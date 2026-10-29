import { requiredSecret } from '@tickethub/common/env';

// Configuración leída del entorno. Falla al arrancar si falta un secreto obligatorio.

export const config = {
  port: Number(process.env.PORT ?? 3001),
  jwtSecret: requiredSecret('JWT_SECRET'),
  jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN ?? 3600),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 10),
  smtp: {
    host: process.env.SMTP_HOST ?? 'mailpit',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.MAIL_FROM ?? 'TicketHub <no-reply@tickethub.local>',
  },
};
