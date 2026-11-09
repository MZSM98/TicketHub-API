import express from 'express';
import { pingDatabase } from '@tickethub/common/db';
import { healthHandler } from '@tickethub/common/health';
import { errorHandler, notFound } from '@tickethub/common/http';
import { config } from './config.js';
import { expireDue } from './reservations.js';
import { router as internalRouter } from './routes/internal.js';
import { router as reservationsRouter } from './routes/reservations.js';
import { router as zonesRouter } from './routes/zones.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', healthHandler('inventory', [pingDatabase]));

const api = express.Router();
api.use(zonesRouter, reservationsRouter, internalRouter);
app.use('/api/v1', api);

app.use(() => {
  throw notFound();
});
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`inventory-service escuchando en el puerto ${config.port}`);
});

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await expireDue();
  } catch (err) {
    console.error(`Error al liberar reservas vencidas: ${err.message}`);
  } finally {
    sweeping = false;
  }
}

const sweeper = config.sweepIntervalMs > 0 ? setInterval(sweep, config.sweepIntervalMs) : null;

process.on('SIGTERM', () => {
  if (sweeper) clearInterval(sweeper);
  server.close(() => process.exit(0));
});
