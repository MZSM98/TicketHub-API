const CLOSE_GRACE_MS = 5000;

const NODE_DEFAULTS = {
  HPE_HEADER_OVERFLOW: 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n',
};
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';

export const REQUEST_TIMEOUT_BODY = JSON.stringify({
  code: 'REQUEST_TIMEOUT',
  message: 'La petición tardó demasiado en llegar completa; intente de nuevo',
});

const requestTimeoutResponse = () =>
  'HTTP/1.1 408 Request Timeout\r\n' +
  'Content-Type: application/json; charset=utf-8\r\n' +
  `Content-Length: ${Buffer.byteLength(REQUEST_TIMEOUT_BODY)}\r\n` +
  'Connection: close\r\n\r\n' +
  REQUEST_TIMEOUT_BODY;

function lingeringClose(socket) {
  socket.on('data', () => {});
  socket.on('error', () => {});
  socket.resume();
  socket.end();
  setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
}

export function onClientError(err, socket) {
  const answered = socket._httpMessage?.headersSent === true;
  if (!socket.writable || answered) return socket.destroy();
  if (err.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    socket.write(requestTimeoutResponse());
    return lingeringClose(socket);
  }
  socket.write(NODE_DEFAULTS[err.code] ?? BAD_REQUEST);
  socket.destroy();
}
