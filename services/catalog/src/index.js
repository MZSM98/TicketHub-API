import express from 'express';
import { pingDatabase } from '@tickethub/common/db';
import { healthHandler } from '@tickethub/common/health';
import { pingStorage } from './storage.js';
import { config } from './config.js';
import { errorHandler, notFound } from '@tickethub/common/http';
import { router as adminRouter } from './routes/admin.js';
import { router as eventsRouter } from './routes/events.js';
import { router as internalRouter } from './routes/internal.js';
import { router as staffRouter } from './routes/staff.js';
import { router as venuesRouter } from './routes/venues.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', healthHandler('catalog', [pingDatabase, pingStorage]));

const api = express.Router();
api.use(eventsRouter, staffRouter, venuesRouter, adminRouter, internalRouter);
app.use('/api/v1', api);

app.use(() => {
  throw notFound();
});
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`catalog-service escuchando en el puerto ${config.port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
