const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const crypto = require("node:crypto");
const { z } = require("zod");
const { query, transaction } = require("../db");
const { asyncRoute, HttpError } = require("../http");
const { createToken, verifyPassword, upgradeLegacyPassword } = require("../auth");
const config = require("../config");

const router = express.Router();
const emailSchema = z.string().trim().email().max(254);
const passwordSchema = z.string().min(12).max(256);

router.post(
  "/admin/login",
  asyncRoute(async (req, res) => {
    const body = z.object({
      username: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(256),
    }).parse(req.body);
    const [account] = await query(
      "SELECT * FROM admin_accounts WHERE username = ? AND active = TRUE LIMIT 1",
      [body.username]
    );
    if (!(await verifyPassword(body.password, account?.password_hash))) {
      throw new HttpError(401, "Invalid username or password.", "INVALID_CREDENTIALS");
    }
    await upgradeLegacyPassword("admin_accounts", account, body.password);
    res.json({
      token: createToken(account, "admin"),
      token_type: "Bearer",
      expires_in: process.env.JWT_EXPIRES_IN || "1h",
      user: { id: account.id, username: account.username, role: "admin" },
    });
  })
);

router.post(
  "/hr/login",
  asyncRoute(async (req, res) => {
    const body = z.object({
      username: emailSchema,
      password: z.string().min(1).max(256),
    }).parse(req.body);
    const [account] = await query(
      "SELECT * FROM hr_accounts WHERE username = ? AND active = TRUE LIMIT 1",
      [body.username.toLowerCase()]
    );
    if (!(await verifyPassword(body.password, account?.password_hash))) {
      throw new HttpError(401, "Invalid HR credentials.", "INVALID_CREDENTIALS");
    }
    await upgradeLegacyPassword("hr_accounts", account, body.password);
    res.json({
      token: createToken(account, "hr"),
      token_type: "Bearer",
      expires_in: process.env.JWT_EXPIRES_IN || "1h",
      user: { id: account.id, username: account.username, email: account.email, role: account.role },
    });
  })
);

router.post(
  "/employee/login",
  asyncRoute(async (req, res) => {
    const body = z.object({
      email: emailSchema,
      password: z.string().min(1).max(256),
    }).parse(req.body);
    const [account] = await query(
      "SELECT * FROM employees WHERE email = ? AND active = TRUE LIMIT 1",
      [body.email.toLowerCase()]
    );
    if (
      !account ||
      account.data?.employment_status === "inactive" ||
      !(await verifyPassword(body.password, account.password_hash))
    ) {
      throw new HttpError(401, "Invalid email or password.", "INVALID_CREDENTIALS");
    }
    await upgradeLegacyPassword("employees", account, body.password);
    res.json({
      token: createToken(account, "employee"),
      token_type: "Bearer",
      expires_in: process.env.JWT_EXPIRES_IN || "1h",
      user: { id: account.id, name: account.name, email: account.email, role: "employee" },
    });
  })
);

router.post(
  "/employee/forgot-password",
  asyncRoute(async (req, res) => {
    const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
    const { mail } = config;
    if (!mail.host || !mail.from || !mail.passwordResetUrl) {
      throw new HttpError(503, "Password reset email is not configured.", "RESET_UNAVAILABLE");
    }
    if (mail.username && !mail.password) {
      throw new HttpError(503, "Password reset email authentication is incomplete.", "RESET_UNAVAILABLE");
    }
    const [account] = await query(
      "SELECT id, email FROM employees WHERE email = ? AND active = TRUE LIMIT 1",
      [email]
    );
    if (account) {
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await query(
        `INSERT INTO employee_password_resets (id, employee_id, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
        [crypto.randomUUID(), account.id, tokenHash, expiresAt]
      );
      const resetUrl = mail.passwordResetUrl.replace("{token}", encodeURIComponent(token));
      const transporter = nodemailer.createTransport({
        host: mail.host,
        port: mail.port,
        secure: mail.port === 465,
        requireTLS: mail.useTls && mail.port !== 465,
        auth: mail.username ? { user: mail.username, pass: mail.password } : undefined,
      });
      try {
        await transporter.sendMail({
          from: mail.from,
          to: account.email,
          subject: "Reset your KMC employee portal password",
          text: `A password reset was requested. Use this link within one hour:\n\n${resetUrl}\n\nIf you did not request this, ignore this message.`,
        });
      } catch (error) {
        await query("DELETE FROM employee_password_resets WHERE token_hash = ?", [tokenHash]);
        console.error("Password reset email delivery failed", { code: error.code || "SMTP_ERROR" });
      }
    }
    res.json({ message: "If an active account matches that email, reset instructions will be sent." });
  })
);

router.post(
  "/employee/reset-password",
  asyncRoute(async (req, res) => {
    const body = z.object({
      token: z.string().min(32).max(128),
      password: passwordSchema,
    }).strict().parse(req.body);
    const tokenHash = crypto.createHash("sha256").update(body.token).digest("hex");
    const passwordHash = await bcrypt.hash(body.password, 12);
    await transaction(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, employee_id FROM employee_password_resets
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
         LIMIT 1 FOR UPDATE`,
        [tokenHash]
      );
      if (!rows.length) {
        throw new HttpError(400, "The password reset link is invalid or expired.", "RESET_TOKEN_INVALID");
      }
      const [updated] = await connection.execute(
        "UPDATE employees SET password_hash = ? WHERE id = ? AND active = TRUE",
        [passwordHash, rows[0].employee_id]
      );
      if (!updated.affectedRows) {
        throw new HttpError(400, "The password reset link is invalid or expired.", "RESET_TOKEN_INVALID");
      }
      await connection.execute(
        "UPDATE employee_password_resets SET used_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [rows[0].id]
      );
      await connection.execute(
        "DELETE FROM employee_password_resets WHERE employee_id = ? AND id <> ?",
        [rows[0].employee_id, rows[0].id]
      );
    });
    res.json({ message: "Password updated." });
  })
);

router.post(
  "/applicant/signup",
  asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(160),
      email: emailSchema,
      phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,24}$/),
      password: passwordSchema,
    }).parse(req.body);
    const id = require("node:crypto").randomUUID();
    const passwordHash = await bcrypt.hash(body.password, 12);
    await query(
      `INSERT INTO applicant_accounts
        (id, name, email, phone, password_hash, mobile_verified, active)
       VALUES (?, ?, ?, ?, ?, FALSE, TRUE)`,
      [id, body.name, body.email.toLowerCase(), body.phone, passwordHash]
    );
    const account = {
      id,
      name: body.name,
      email: body.email.toLowerCase(),
      phone: body.phone,
    };
    res.status(201).json({
      token: createToken(account, "applicant"),
      token_type: "Bearer",
      expires_in: process.env.JWT_EXPIRES_IN || "1h",
      user: { ...account, role: "applicant" },
    });
  })
);

router.post(
  "/applicant/login",
  asyncRoute(async (req, res) => {
    const body = z.object({
      identity: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(256),
    }).parse(req.body);
    const identity = body.identity.includes("@") ? body.identity.toLowerCase() : body.identity;
    const [account] = await query(
      `SELECT * FROM applicant_accounts
       WHERE active = TRUE AND (email = ? OR phone = ?) LIMIT 1`,
      [identity, identity]
    );
    if (!(await verifyPassword(body.password, account?.password_hash))) {
      throw new HttpError(401, "Invalid email/mobile number or password.", "INVALID_CREDENTIALS");
    }
    await upgradeLegacyPassword("applicant_accounts", account, body.password);
    res.json({
      token: createToken(account, "applicant"),
      token_type: "Bearer",
      expires_in: process.env.JWT_EXPIRES_IN || "1h",
      user: { id: account.id, name: account.name, email: account.email, phone: account.phone, role: "applicant" },
    });
  })
);

module.exports = router;
