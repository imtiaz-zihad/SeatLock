import "dotenv/config"; // sobar age: env load hoy
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 4000);

const server = app.listen(port, () => {
  console.log(`SeatLock API running on http://localhost:${port}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));