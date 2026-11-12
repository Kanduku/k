class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function requireId(value, label = "id") {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f\d]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(value)
  ) {
    throw new HttpError(400, `Invalid ${label}.`, "INVALID_ID");
  }
  return value;
}

function parsePage(query) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page || "1", 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit || "25", 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

function serializeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    return res.status(error.status).json({
      error: { code: error.code || "REQUEST_ERROR", message: error.message },
    });
  }
  if (error && error.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      error: { code: "DUPLICATE_RECORD", message: "A record with that value already exists." },
    });
  }
  if (error && error.name === "ZodError") {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      },
    });
  }
  if (error && error.name === "MulterError") {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: { code: error.code, message: error.message },
    });
  }
  console.error("API request failed", {
    method: req.method,
    path: req.path,
    message: error && error.message,
  });
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
  });
}

module.exports = {
  HttpError,
  asyncRoute,
  requireId,
  parsePage,
  serializeJson,
  parseJson,
  errorHandler,
};
