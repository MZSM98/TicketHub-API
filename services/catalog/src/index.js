import express from 'express';
import { config } from './config.js';
import { errorHandler, notFound } from './http.js';
import { router as adminRouter } from './routes/admin.js';
import { router as eventsRouter } from './routes/events.js';
import { router as internalRouter } from './routes/internal.js';
import { router as staffRouter } from './routes/staff.js';
import { router as venuesRouter } from './routes/venues.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'UP', service: 'catalog' });
});

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
