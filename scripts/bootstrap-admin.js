require("dotenv").config();

const bcrypt = require("bcryptjs");
const { randomUUID } = require("node:crypto");
const { query, close } = require("../src/db");

async function main() {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password || password.length < 12 || password.length > 256) {
    throw new Error(
      "Set BOOTSTRAP_ADMIN_USERNAME and a BOOTSTRAP_ADMIN_PASSWORD of 12 to 256 characters for this one-time command."
    );
  }
  const hash = await bcrypt.hash(password, 12);
  await query(
    "INSERT INTO admin_accounts (id, username, password_hash, active) VALUES (?, ?, ?, TRUE)",
    [randomUUID(), username, hash]
  );
  console.log(`Created admin account "${username}". Remove the bootstrap variables after this command.`);
}

main()
  .catch((error) => {
    console.error("Admin bootstrap failed:", error.message);
    process.exitCode = 1;
  })
  .finally(close);
