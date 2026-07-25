import { createMockApiServer } from "./create-server.js";

const PORT = Number(process.env.PORT ?? 4311);
const SHUTDOWN_TIMEOUT_MS = 5000;

const server = createMockApiServer();

server.listen(PORT, () => {
  console.log(`http-test-service listening on http://127.0.0.1:${PORT}`);
});

function shutdown(signal) {
  console.log(`http-test-service received ${signal}, shutting down`);
  const forceExitTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
