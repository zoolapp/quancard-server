import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { DowngradeError, openDatabase } from "./db.js";

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof TypeError) {
      console.error(`quancard-server: configuration error: ${error.message}`);
      process.exit(78);
    }
    throw error;
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(config.dataDir);
  } catch (error) {
    if (error instanceof DowngradeError) {
      console.error(`quancard-server: ${error.message}`);
      process.exit(65);
    }
    throw error;
  }
  const app = await buildApp(config, db, { logger: true });
  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await app.listen({ host: config.host, port: config.port });
  if (!config.publicOrigin) app.log.warn("QC_ALLOW_INSECURE_LOCALHOST=1: plain HTTP accepted for localhost only. Do not expose this port.");
  if (config.setupToken) app.log.info("Owner setup is enabled until the first account is created.");
}

void main();
