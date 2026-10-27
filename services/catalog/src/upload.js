import Busboy from 'busboy';
import { HttpError } from '@tickethub/common/http';

export const MAX_POSTER_BYTES = 5 * 1024 * 1024;

const SIGNATURES = [
  { contentType: 'image/jpeg', extension: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  {
    contentType: 'image/png',
    extension: 'png',
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
];

const fileMissing = () =>
  new HttpError(400, 'VALIDATION_ERROR', 'Por favor llene todos los campos requeridos', {
    fields: [{ field: 'file', issue: 'required' }],
  });
const tooLarge = () => new HttpError(413, 'FILE_TOO_LARGE', 'La imagen no debe superar 5 MB');
const unsupported = () =>
  new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Solo se permiten imágenes JPG o PNG');

export function imageType(buffer) {
  return SIGNATURES.find(({ bytes }) => bytes.every((byte, i) => buffer[i] === byte)) ?? null;
}

function readFileField(req) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_POSTER_BYTES } });
    } catch {
      return reject(fileMissing());
    }
    let result = null;
    busboy.on('file', (name, stream) => {
      if (name !== 'file' || result) return stream.resume();
      const chunks = [];
      result = { truncated: false };
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        result.truncated = true;
      });
      stream.on('end', () => {
        result.buffer = Buffer.concat(chunks);
      });
    });
    busboy.on('error', () => reject(fileMissing()));
    busboy.on('close', () => resolve(result));
    req.pipe(busboy);
  });
}

export async function readPoster(req) {
  const file = await readFileField(req);
  if (!file || !file.buffer || file.buffer.length === 0) throw fileMissing();
  if (file.truncated) throw tooLarge();
  const type = imageType(file.buffer);
  if (!type) throw unsupported();
  return { buffer: file.buffer, ...type };
}
