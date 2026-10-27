export const NEW_PASSWORD_RULE = {
  type: 'string',
  required: true,
  minLength: 8,
  maxLength: 72,
  maxBytes: 72,
  messages: {
    too_short: 'La contraseña debe tener al menos 8 caracteres',
    too_long:
      'La contraseña no puede pasar de 72 bytes; los acentos y la ñ cuentan como 2, use una más corta',
  },
};
