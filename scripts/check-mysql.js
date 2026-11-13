require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const config = require("../src/config");

async function main() {
  const pool = mysql.createPool({
    ...config.db,
    waitForConnections: true,
    connectionLimit: 1,
    charset: "utf8mb4",
    timezone: "Z",
    ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
  });

  try {
    const [result] = await pool.query("SELECT 1 AS connection_ok");
    if (Number(result[0].connection_ok) !== 1) {
      throw new Error("MySQL did not return the expected connection result.");
    }

    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    const expectedTables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?([a-z0-9_]+)`?/gi)]
      .map((match) => match[1]);
    const [rows] = await pool.query("SHOW TABLES");
    const existingTables = new Set(rows.map((row) => Object.values(row)[0]));
    const missingTables = expectedTables.filter((table) => !existingTables.has(table));

    console.log(`Connected to MySQL at ${config.db.host}; database "${config.db.database}".`);
    if (missingTables.length) {
      console.error(`Missing ${missingTables.length} schema tables: ${missingTables.join(", ")}`);
      console.error("Apply the schema with: npm run db:schema");
      process.exitCode = 1;
    } else {
      const [trainingColumns] = await pool.query(
        "SHOW COLUMNS FROM training_applications LIKE 'referral_from'"
      );
      if (trainingColumns.length === 0) {
        console.error("Missing schema column: training_applications.referral_from");
        console.error("Apply the schema with: npm run db:schema");
        process.exitCode = 1;
      } else {
        console.log(`Schema check passed (${expectedTables.length} expected tables and required columns are present).`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    `MySQL check failed for ${config.db.host}/${config.db.database}:`,
    error.code || error.message
  );
  if (["ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND"].includes(error.code)) {
    console.error("Verify the hPanel database host, remote-access/IP allowlist, and DB_SSL setting.");
  }
  process.exitCode = 1;
});
