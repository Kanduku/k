const app = require("./app");
const config = require("./config");
const { pool, close } = require("./db");

async function start() {
  if (Buffer.byteLength(config.jwtSecret) < 32) {
    throw new Error("JWT_SECRET must contain at least 32 bytes");
  }
  await pool.query("SELECT 1");
  const server = app.listen(config.port, () => {
    console.log(`KMC API listening on port ${config.port}`);
  });

  const shutdown = () => {
    server.close(async (error) => {
      if (error) {
        console.error("API shutdown failed", { message: error.message });
        process.exitCode = 1;
      }
      await close();
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

start().catch((error) => {
  console.error("API startup failed", { message: error.message });
  process.exitCode = 1;
});
