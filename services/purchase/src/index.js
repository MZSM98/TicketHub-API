import express from 'express';
import { query } from '@tickethub/common/db';
import { errorHandler, notFound } from '@tickethub/common/http';
import { config } from './config.js';
import { router as internalRouter } from './routes/internal.js';
import { router as purchasesRouter } from './routes/purchases.js';
import { router as salesRouter } from './routes/sales.js';
import { schemaError, schemaProblems } from './schema.js';
import { startPaymentSweep } from './sweep.js';
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

const columns = await query(
  `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`, COLUMN_TYPE AS type
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('purchases', 'payment_attempts')`,
);
const problems = schemaProblems(columns);
if (problems.length > 0) {
  console.error(schemaError(problems).message);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`purchase-service escuchando en el puerto ${config.port}`);
});

const timers = [startTicketRetries(), startPaymentSweep()].filter(Boolean);

process.on('SIGTERM', () => {
  for (const timer of timers) clearInterval(timer);
  server.close(() => process.exit(0));
});
