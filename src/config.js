require("dotenv").config();

const required = (name) => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
};

const bool = (name, fallback = false) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!["true", "false"].includes(value.toLowerCase())) {
    throw new Error(`${name} must be true or false`);
  }
  return value.toLowerCase() === "true";
};

const jwtSecret = (process.env.JWT_SECRET || "").trim();

const encryptionKey = process.env.APPLICANT_DATA_ENCRYPTION_KEY || "";
if (encryptionKey && Buffer.from(encryptionKey, "base64").length !== 32) {
  throw new Error("APPLICANT_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
}

module.exports = Object.freeze({
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  apiBasePath: process.env.API_BASE_PATH || "/api",
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h",
  db: Object.freeze({
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT || 3306),
    database: required("DB_NAME"),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    ssl: bool("DB_SSL"),
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
  }),
  uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES || 2 * 1024 * 1024),
  applicantEncryptionKey: encryptionKey
    ? Buffer.from(encryptionKey, "base64")
    : null,
  mail: Object.freeze({
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    username: process.env.SMTP_USERNAME || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.SMTP_FROM_EMAIL || "",
    useTls: bool("SMTP_USE_TLS", true),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    passwordResetUrl: process.env.PASSWORD_RESET_URL || "",
  }),
});
