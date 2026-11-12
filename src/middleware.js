const multer = require("multer");
const { HttpError } = require("./http");
const config = require("./config");

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploadMaxBytes, files: 12 },
});

function validateUpload(file, type) {
  const extension = file.originalname.toLowerCase().split(".").pop();
  const signature = file.buffer.subarray(0, 8);
  const specs = {
    resume: {
      extensions: ["pdf", "docx"],
      valid: (ext) =>
        (ext === "pdf" && signature.subarray(0, 5).toString() === "%PDF-") ||
        (ext === "docx" && signature[0] === 0x50 && signature[1] === 0x4b),
    },
    photo: {
      extensions: ["jpg", "jpeg", "png"],
      valid: (ext) =>
        (["jpg", "jpeg"].includes(ext) &&
          signature[0] === 0xff &&
          signature[1] === 0xd8 &&
          signature[2] === 0xff) ||
        (ext === "png" && signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))),
    },
    government_id: {
      extensions: ["pdf", "jpg", "jpeg", "png"],
      valid: (ext) =>
        (ext === "pdf" && signature.subarray(0, 5).toString() === "%PDF-") ||
        (["jpg", "jpeg"].includes(ext) &&
          signature[0] === 0xff &&
          signature[1] === 0xd8 &&
          signature[2] === 0xff) ||
        (ext === "png" && signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))),
    },
    employee_pdf: {
      extensions: ["pdf"],
      valid: (ext) => ext === "pdf" && signature.subarray(0, 5).toString() === "%PDF-",
    },
    transcript: {
      extensions: ["pdf"],
      valid: (ext) => ext === "pdf" && signature.subarray(0, 5).toString() === "%PDF-",
    },
  };
  const spec = specs[type];
  if (!spec || !spec.extensions.includes(extension) || !spec.valid(extension)) {
    throw new HttpError(400, `The ${type.replace("_", " ")} file has an invalid format.`);
  }
  if (
    type === "employee_pdf" &&
    !["application/pdf", "application/octet-stream"].includes(file.mimetype)
  ) {
    throw new HttpError(400, "The employee document must be a PDF.");
  }
}

function safeFilename(filename) {
  const name = String(filename || "").split(/[\\/]/).pop().replace(/[^\w .()-]/g, "_").trim();
  if (!name || name.length > 200) {
    throw new HttpError(400, "The uploaded file name is invalid.");
  }
  return name;
}

module.exports = { memoryUpload, validateUpload, safeFilename };
