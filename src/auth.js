const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const config = require("./config");
const { query } = require("./db");
const { HttpError, parseJson } = require("./http");

const pbkdf2 = promisify(crypto.pbkdf2);
const scrypt = promisify(crypto.scrypt);

function createToken(account, role) {
  return jwt.sign(
    { role, username: account.username || account.email },
    config.jwtSecret,
    { subject: String(account.id), expiresIn: config.jwtExpiresIn }
  );
}

function authenticate(roles = []) {
  return async (req, res, next) => {
    try {
      const authorization = req.get("authorization") || "";
      const [scheme, token] = authorization.split(" ");
      if (scheme !== "Bearer" || !token) {
        throw new HttpError(401, "Authentication is required.", "AUTH_REQUIRED");
      }
      const claims = jwt.verify(token, config.jwtSecret);
      if (roles.length && !roles.includes(claims.role)) {
        throw new HttpError(403, "You do not have permission to access this resource.", "FORBIDDEN");
      }
      const account = await loadActiveAccount(claims.role, claims.sub);
      if (!account) {
        throw new HttpError(401, "The account is inactive or no longer exists.", "AUTH_INVALID");
      }
      req.user = { ...account, role: claims.role };
      next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        return next(new HttpError(401, "The access token is invalid or expired.", "AUTH_INVALID"));
      }
      next(error);
    }
  };
}

async function loadActiveAccount(role, id) {
  const table = {
    admin: "admin_accounts",
    hr: "hr_accounts",
    applicant: "applicant_accounts",
    employee: "employees",
  }[role];
  if (!table) return null;
  const rows = await query(
    `SELECT * FROM ${table} WHERE id = ? AND active = TRUE LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  if (rows[0].data !== undefined) rows[0].data = parseJson(rows[0].data);
  if (role === "employee" && rows[0].data.employment_status === "inactive") return null;
  return rows[0];
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, "You do not have permission to access this resource.", "FORBIDDEN"));
    }
    next();
  };
}

async function verifyPassword(password, hash) {
  if (!hash || typeof password !== "string") return false;
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$")) {
    return bcrypt.compare(password, hash);
  }
  const [method, salt, expectedHex] = hash.split("$");
  if (!method || !salt || !/^[a-f\d]+$/i.test(expectedHex || "") || expectedHex.length % 2 !== 0) {
    return false;
  }
  let actual;
  if (method.startsWith("pbkdf2:")) {
    const [, algorithm, countText] = method.split(":");
    const iterations = Number(countText);
    if (!/^(sha256|sha512)$/.test(algorithm) || !Number.isInteger(iterations) || iterations < 1 || iterations > 2000000) {
      return false;
    }
    actual = await pbkdf2(password, salt, iterations, expectedHex.length / 2, algorithm);
  } else if (method.startsWith("scrypt:")) {
    const [, nText, rText, pText] = method.split(":");
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (
      !Number.isInteger(n) || n < 2 || n > 131072 || (n & (n - 1)) !== 0 ||
      !Number.isInteger(r) || r < 1 || r > 32 ||
      !Number.isInteger(p) || p < 1 || p > 16
    ) {
      return false;
    }
    const maxmem = Math.max(64 * 1024 * 1024, 128 * n * r + 128 * r * p + 1024 * 1024);
    actual = await scrypt(password, salt, expectedHex.length / 2, { N: n, r, p, maxmem });
  } else {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function upgradeLegacyPassword(table, account, password) {
  if (!account.password_hash || account.password_hash.startsWith("$2")) return;
  const passwordHash = await bcrypt.hash(password, 12);
  const allowedTables = new Set(["admin_accounts", "hr_accounts", "applicant_accounts", "employees"]);
  if (!allowedTables.has(table)) throw new Error("Invalid account table.");
  await query(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [passwordHash, account.id]);
}

module.exports = {
  createToken,
  authenticate,
  requireRole,
  verifyPassword,
  upgradeLegacyPassword,
};
