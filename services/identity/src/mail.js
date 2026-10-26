import nodemailer from 'nodemailer';
import { config } from './config.js';

const { smtp } = config;

// Tiempos cortos: si el SMTP no responde, la cuenta se crea igual y se responde
// credentialsEmailSent: false antes de que venza el tiempo de espera del gateway.
const transporter = nodemailer.createTransport({
  host: smtp.host,
  port: smtp.port,
  secure: smtp.secure,
  auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  connectionTimeout: 5_000,
  greetingTimeout: 5_000,
  socketTimeout: 5_000,
});

const ROLE_LABEL = { ORGANIZER: 'organizador', STAFF: 'personal de evento' };

/**
 * Envía las credenciales temporales (CU-15 y alta de personal). Regresa false si el SMTP falla,
 * para responder credentialsEmailSent: false. Nunca registra la contraseña.
 */
export async function sendCredentialsEmail({ to, name, role, temporaryPassword }) {
  const text = [
    `Hola ${name}:`,
    '',
    `Se creó tu cuenta de ${ROLE_LABEL[role]} en TicketHub.`,
    '',
    `Correo: ${to}`,
    `Contraseña temporal: ${temporaryPassword}`,
    '',
    'Al iniciar sesión se te pedirá cambiar la contraseña.',
    'Si no esperabas este correo, ignóralo.',
  ].join('\n');
  try {
    await transporter.sendMail({
      from: smtp.from,
      to,
      subject: 'Tus credenciales de acceso a TicketHub',
      text,
    });
    return true;
  } catch (error) {
    console.error(
      `No se pudo enviar el correo de credenciales a ${to}: ${error.code ?? error.message}`,
    );
    return false;
  }
}
