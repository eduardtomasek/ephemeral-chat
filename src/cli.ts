import { loadRuntimeConfig } from "./config.js";
import { createAppServer } from "./server.js";

const config = loadRuntimeConfig();
const server = createAppServer({ config });

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

server.listen(config.port, config.host).catch((error: unknown) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
