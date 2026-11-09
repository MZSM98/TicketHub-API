export const REQUIRED_COLUMNS = [
  { table: 'purchases', column: 'ticket_issuance', includes: ["'FAILED'"] },
  { table: 'payment_attempts', column: 'status', includes: ["'RECOVERY_FAILED'"] },
  { table: 'payment_attempts', column: 'recovery_attempts', includes: [] },
];

export function schemaProblems(columns) {
  const byName = new Map(columns.map((c) => [`${c.table}.${c.column}`, c.type]));
  const problems = [];
  for (const { table, column, includes } of REQUIRED_COLUMNS) {
    const type = byName.get(`${table}.${column}`);
    if (type === undefined) problems.push(`falta la columna ${table}.${column}`);
    else {
      for (const value of includes) {
        if (!type.includes(value)) problems.push(`${table}.${column} no admite ${value}`);
      }
    }
  }
  return problems;
}

export function schemaError(problems) {
  return new Error(
    `El esquema de tickethub_purchase está desactualizado (${problems.join('; ')}). ` +
      'Recrea la base con `docker compose down -v && docker compose up -d` o aplica los cambios de db/init/04-purchase.sql con ALTER TABLE.',
  );
}
