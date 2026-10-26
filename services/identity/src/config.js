// Configuración leída del entorno. Falla al arrancar si falta un secreto obligatorio.
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN ?? 3600),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
  internalToken: required('INTERNAL_TOKEN'),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 10),
  db: {
    host: process.env.MYSQL_HOST ?? 'mysql',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  smtp: {
    host: process.env.SMTP_HOST ?? 'mailpit',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.MAIL_FROM ?? 'TicketHub <no-reply@tickethub.local>',
  },
};
