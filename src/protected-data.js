const crypto = require("node:crypto");
const config = require("./config");
const { HttpError } = require("./http");

function encryptBuffer(buffer) {
  if (!config.applicantEncryptionKey) {
    throw new HttpError(503, "Applicant data encryption is not configured.", "ENCRYPTION_NOT_CONFIGURED");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.applicantEncryptionKey, iv);
  return {
    data: Buffer.concat([cipher.update(buffer), cipher.final()]),
    iv,
    tag: cipher.getAuthTag(),
  };
}

function decryptBuffer(data, iv, tag) {
  if (!config.applicantEncryptionKey || !iv || !tag) {
    throw new HttpError(503, "Encrypted data cannot be read; encryption configuration is missing.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.applicantEncryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function protectProfile(profile) {
  const result = { ...profile };
  const value = result.government_id_number;
  if (typeof value !== "string" || !value) return result;
  const encrypted = encryptBuffer(Buffer.from(value, "utf8"));
  result.government_id_number = {
    _encrypted: true,
    data: encrypted.data.toString("base64"),
    iv: encrypted.iv.toString("base64"),
    tag: encrypted.tag.toString("base64"),
  };
  return result;
}

function unprotectProfile(profile) {
  const result = { ...profile };
  const value = result.government_id_number;
  if (!value || typeof value !== "object" || value._encrypted !== true) return result;
  result.government_id_number = decryptBuffer(
    Buffer.from(value.data, "base64"),
    Buffer.from(value.iv, "base64"),
    Buffer.from(value.tag, "base64")
  ).toString("utf8");
  return result;
}

module.exports = { encryptBuffer, decryptBuffer, protectProfile, unprotectProfile };
