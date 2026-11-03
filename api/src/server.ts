import "dotenv/config"; // sobar age: env load hoy
import { app } from "./app.js";
import { startExpiryJob } from "./jobs/expire-holds.js";

const port = Number(process.env.PORT ?? 4000);

const server = app.listen(port, () => {
  console.log(`SeatLock API running on http://localhost:${port}`);
});

// Background jobs (set DISABLE_JOBS=true to turn them off, e.g. in a second instance)
const expiryJob = process.env.DISABLE_JOBS === "true" ? null : startExpiryJob();

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  expiryJob?.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
