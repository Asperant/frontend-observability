import { createMockApiServer } from "./create-server.js";

const PORT = Number(process.env.PORT ?? 4311);

const server = createMockApiServer();

server.listen(PORT, () => {
  console.log(`mock-api listening on http://127.0.0.1:${PORT}`);
});
