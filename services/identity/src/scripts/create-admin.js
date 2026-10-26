// Crea el primer usuario ADMIN a partir de ADMIN_NAME, ADMIN_EMAIL y ADMIN_PASSWORD.
// Idempotente: si el correo ya existe (aunque esté borrado lógicamente) no cambia nada y sale con 0.
// Nunca imprime la contraseña.
import bcrypt from 'bcrypt';
import mysql from 'mysql2/promise';

function fail(message) {
  console.error(`create-admin: ${message}`);
  process.exit(1);
}

function readConfig(env) {
  const name = env.ADMIN_NAME?.trim();
  const email = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD ?? '';
  const rounds = Number(env.BCRYPT_ROUNDS ?? 10);

  // Mismos límites que identity.yaml (User.name, Email, Password).
  if (!name || name.length > 120) fail('ADMIN_NAME es obligatorio (máximo 120 caracteres).');
  if (!email || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('ADMIN_EMAIL es obligatorio y debe ser un correo válido.');
  }
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (password.length < 8 || passwordBytes > 72) {
    fail('ADMIN_PASSWORD debe tener al menos 8 caracteres y máximo 72 bytes.');
  }
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
    fail('BCRYPT_ROUNDS debe ser un entero entre 4 y 31.');
  }
  return { name, email, password, rounds };
}

async function main() {
  const { name, email, password, rounds } = readConfig(process.env);
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    const [existing] = await db.execute('SELECT id, role FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      const { id, role } = existing[0];
      console.log(`El correo ${email} ya existe (id ${id}, rol ${role}). No se cambió nada.`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, rounds);
    try {
      // must_change_password = FALSE: según identity.yaml solo se marca cuando el sistema genera
      // la contraseña y la manda por correo; aquí la elige quien ejecuta el script.
      const [result] = await db.execute(
        `INSERT INTO users (name, email, password_hash, role, status, must_change_password)
         VALUES (?, ?, ?, 'ADMIN', 'ACTIVE', FALSE)`,
        [name, email, passwordHash],
      );
      console.log(`Administrador creado: id ${result.insertId}, ${email}.`);
    } catch (error) {
      // Otra ejecución lo creó entre el SELECT y el INSERT.
      if (error.code === 'ER_DUP_ENTRY') {
        console.log(`El correo ${email} ya existe. No se cambió nada.`);
        return;
      }
      throw error;
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => fail(error.message));
