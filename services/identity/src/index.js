import express from 'express';
import { pingDatabase } from '@tickethub/common/db';
import { healthHandler } from '@tickethub/common/health';
import { config } from './config.js';
import { errorHandler, notFound } from '@tickethub/common/http';
import { router as adminRouter } from './routes/admin.js';
import { router as authRouter } from './routes/auth.js';
import { router as internalRouter } from './routes/internal.js';
import { router as meRouter } from './routes/me.js';
import { router as organizerRouter } from './routes/organizer.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', healthHandler('identity', [pingDatabase]));

const api = express.Router();
api.use(authRouter, meRouter, adminRouter, organizerRouter, internalRouter);
app.use('/api/v1', api);

app.use(() => {
  throw notFound();
});
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`identity-service escuchando en el puerto ${config.port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
