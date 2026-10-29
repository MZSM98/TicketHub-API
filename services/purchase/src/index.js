import express from 'express';
import { errorHandler, notFound } from '@tickethub/common/http';
import { config } from './config.js';
import { router as internalRouter } from './routes/internal.js';
import { router as purchasesRouter } from './routes/purchases.js';
import { router as salesRouter } from './routes/sales.js';
import { startTicketRetries } from './tickets.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'UP', service: 'purchase' });
});

const api = express.Router();
api.use(purchasesRouter, salesRouter, internalRouter);
app.use('/api/v1', api);

app.use(() => {
  throw notFound();
});
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`purchase-service escuchando en el puerto ${config.port}`);
});

const retries = startTicketRetries();

process.on('SIGTERM', () => {
  if (retries) clearInterval(retries);
  server.close(() => process.exit(0));
});
