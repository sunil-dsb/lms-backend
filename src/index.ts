import config from './config/env.ts';
import app from './app.ts';
import { logger } from './config/logger.ts';
import { closeDb, sql } from './db/client.ts';

// Server entrypoint
const server = app.listen(config.port, () => {
  console.log(`⚙️  Server is running at port : ${config.port}`);

  sql<{ ok: number }[]>`select 1 as ok`
    .then(() => {
      console.log('✅ Database connected successfully');
    })
    .catch((err) => {
      console.error('❌ Database connection failed:', err);
      process.exit(1);
    });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');

  // Stop accepting new connections; existing requests get to finish.
  server.close(() => logger.info('http server closed'));

  // Close the pool. sql.end() waits for in-flight queries up to its timeout.
  await closeDb();
  logger.info('db pool closed');

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// trigger restart
