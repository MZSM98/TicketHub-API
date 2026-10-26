import express from 'express';

const SERVICE = 'ticket';
const port = Number(process.env.PORT ?? 3005);

const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({ status: 'UP', service: SERVICE });
});

const server = app.listen(port, () => {
  console.log(`${SERVICE}-service escuchando en el puerto ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
