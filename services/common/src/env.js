export const MIN_SECRET_LENGTH = 32;

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function checkSecret(name, value) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
  }
  return value;
}

export const requiredSecret = (name) => checkSecret(name, process.env[name]);
