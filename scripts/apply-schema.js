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
    multipleStatements: false,
    charset: "utf8mb4",
    timezone: "Z",
    ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    const statements = schema
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await pool.query(statement);
    console.log(`Applied ${statements.length} schema statements.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Schema setup failed:", error.message);
  process.exitCode = 1;
});
