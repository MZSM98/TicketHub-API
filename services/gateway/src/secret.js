export const MIN_SECRET_LENGTH = 32;

export function checkJwtSecret(value) {
  if (!value) throw new Error('Falta la variable de entorno JWT_SECRET');
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
  }
  return value;
}
