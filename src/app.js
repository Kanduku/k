const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { pool } = require("./db");
const { asyncRoute, errorHandler } = require("./http");
const authRoutes = require("./routes/auth");
const publicRoutes = require("./routes/public");
const applicantRoutes = require("./routes/applicant");
const hrRoutes = require("./routes/hr");
const employeeRoutes = require("./routes/employee");
const adminRoutes = require("./routes/admin");

const app = express();
const api = express.Router();

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin: "*",
    credentials: false,
  })
);
app.use(express.json({ limit: "1mb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

api.get(
  "/health",
  asyncRoute(async (req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  })
);
api.use(
  "/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." } },
  }),
  authRoutes
);
api.use(
  "/public",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
  }),
  publicRoutes
);
api.use("/applicant", applicantRoutes);
api.use("/hr", hrRoutes);
api.use("/employee", employeeRoutes);
api.use("/admin", adminRoutes);
app.use(config.apiBasePath, api);
app.use((req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "API endpoint not found." } });
});
app.use(errorHandler);

module.exports = app;
