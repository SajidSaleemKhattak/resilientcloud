import express, { type Express } from 'express';

export interface HealthState {
  isReady(): boolean;
  markUnhealthy(): void;
}

export function createHealthState(): HealthState {
  let ready = true;
  return {
    isReady: () => ready,
    // Deliberately sticky: the process must be restarted to recover.
    markUnhealthy: () => { ready = false; },
  };
}

export interface AppOptions {
  instance: string;
  health?: HealthState;
}

export function createApp({ instance, health = createHealthState() }: AppOptions): Express {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(instance)) {
    throw new Error('INSTANCE_ID must be 1–64 letters, digits, dots, underscores, or hyphens.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Instance-Id', instance);
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/live', (_req, res) => {
    res.json({ instance, alive: true });
  });

  app.get('/ready', (_req, res) => {
    const ready = health.isReady();
    res.status(ready ? 200 : 503).json({ instance, ready });
  });

  app.get('/api', (_req, res) => {
    if (!health.isReady()) {
      res.status(503).json({ instance, error: 'instance_unhealthy' });
      return;
    }
    res.json({ instance, message: 'Hello from ResilientCloud' });
  });

  app.use((_req, res) => {
    res.status(404).json({ instance, error: 'not_found' });
  });

  return app;
}

export function createBackend({ instance }: Pick<AppOptions, 'instance'>) {
  const health = createHealthState();
  return { app: createApp({ instance, health }), ...health };
}
