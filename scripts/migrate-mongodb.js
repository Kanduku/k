require("dotenv").config();

const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const config = require("../src/config");

const COLLECTIONS = [
  "career_opportunities",
  "partners",
  "applicant_accounts",
  "employees",
  "hr_accounts",
  "hiring_stages",
  "applications",
  "contacts",
  "partner_inquiries",
  "training_applications",
  "projects",
  "employee_documents",
  "employee_promotions",
  "project_updates",
  "leave_requests",
  "employee_referrals",
  "hiring_audit_logs",
];

function legacyId(value) {
  if (value instanceof ObjectId) return value.toHexString();
  return String(value);
}

function migrateProfile(profile) {
  const result = { ...(profile || {}) };
  const encryptedValue = result.government_id_number_encrypted;
  if (typeof encryptedValue === "string" && encryptedValue) {
    const protectedValue = encrypt(decryptFernet(encryptedValue));
    result.government_id_number = {
      _encrypted: true,
      data: protectedValue.fileData.toString("base64"),
      iv: protectedValue.iv.toString("base64"),
      tag: protectedValue.tag.toString("base64"),
    };
    delete result.government_id_number_encrypted;
  }
  return result;
}

function plain(value) {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "_id") output.id = legacyId(item);
      else output[key] = plain(item);
    }
    return output;
  }
  return value;
}

function json(value) {
  return JSON.stringify(plain(value));
}

function dateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ref(value) {
  if (!value) return null;
  return value instanceof ObjectId ? value.toHexString() : String(value);
}

function safeDateString(value) {
  const date = dateValue(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function encrypt(data) {
  if (!config.applicantEncryptionKey) {
    throw new Error("APPLICANT_DATA_ENCRYPTION_KEY is required to migrate encrypted applicant documents.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.applicantEncryptionKey, iv);
  return {
    fileData: Buffer.concat([cipher.update(data), cipher.final()]),
    iv,
    tag: cipher.getAuthTag(),
  };
}

function decryptFernet(token) {
  const keyText = process.env.MONGO_FERNET_KEY || process.env.APPLICANT_DATA_ENCRYPTION_KEY;
  if (!keyText) {
    throw new Error("MONGO_FERNET_KEY is required to migrate encrypted applicant documents.");
  }
  const key = Buffer.from(keyText, "base64");
  if (key.length !== 32) throw new Error("MONGO_FERNET_KEY must be the old Fernet key.");
  const encoded = Buffer.isBuffer(token) ? token.toString("utf8") : String(token);
  const raw = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length < 73 || raw[0] !== 0x80) throw new Error("Invalid legacy Fernet token.");
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16);
  const signed = raw.subarray(0, raw.length - 32);
  const supplied = raw.subarray(raw.length - 32);
  const expected = crypto.createHmac("sha256", signingKey).update(signed).digest();
  if (!crypto.timingSafeEqual(supplied, expected)) throw new Error("Legacy Fernet token authentication failed.");
  const iv = raw.subarray(9, 25);
  const ciphertext = raw.subarray(25, raw.length - 32);
  const decipher = crypto.createDecipheriv("aes-128-cbc", encryptionKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function downloadGridfs(bucket, fileId) {
  const id = fileId instanceof ObjectId ? fileId : new ObjectId(String(fileId));
  const chunks = [];
  for await (const chunk of bucket.openDownloadStream(id)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function insert(connection, sql, values) {
  return connection.execute(sql, values);
}

async function saveLegacy(connection, collection, document) {
  await insert(
    connection,
    `INSERT INTO legacy_records (collection_name, legacy_id, payload)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
    [collection, legacyId(document._id), json(document)]
  );
}

async function importTyped(connection, collection, d, buckets) {
  const id = legacyId(d._id);
  const data = json(d);
  const created = dateValue(d.created_at) || new Date();
  const updated = dateValue(d.updated_at) || created;
  switch (collection) {
    case "career_opportunities":
      await insert(connection,
        `INSERT INTO career_opportunities
         (id, opportunity_type, title, slug, published, summary, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE opportunity_type=VALUES(opportunity_type), title=VALUES(title),
           slug=VALUES(slug), published=VALUES(published), summary=VALUES(summary),
           data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.opportunity_type || "job", d.title || "Untitled", d.slug || null,
          Boolean(d.published), d.summary || null, data, created, updated]);
      break;
    case "partners":
      await insert(connection,
        `INSERT INTO partners (id, name, published, logo_url, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), published=VALUES(published),
           logo_url=VALUES(logo_url), data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.name || d.title || "Partner", Boolean(d.published), d.logo_url || d.logo || null,
          data, created, updated]);
      break;
    case "applicant_accounts":
      await insert(connection,
        `INSERT INTO applicant_accounts
         (id, name, email, phone, password_hash, mobile_verified, active, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), phone=VALUES(phone),
           password_hash=VALUES(password_hash), mobile_verified=VALUES(mobile_verified),
           active=VALUES(active), data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.name || "", d.email || `${id}@legacy.invalid`, d.phone || `legacy-${id}`,
          d.password_hash || "", Boolean(d.mobile_verified), d.active !== false, data, created, updated]);
      break;
    case "applications":
      await insert(connection,
        `INSERT INTO applications
         (id, applicant_id, opportunity_id, opportunity_title, name, email, phone, message,
          status, internal_notes, profile, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE applicant_id=VALUES(applicant_id), opportunity_id=VALUES(opportunity_id),
           opportunity_title=VALUES(opportunity_title), name=VALUES(name), email=VALUES(email),
           phone=VALUES(phone), message=VALUES(message), status=VALUES(status),
           internal_notes=VALUES(internal_notes), profile=VALUES(profile), data=VALUES(data),
           updated_at=VALUES(updated_at)`,
        [id, ref(d.applicant_id), ref(d.opportunity_id) || "unknown",
          d.opportunity_title || "Legacy opportunity", d.name || "", d.email || "",
          d.phone || "", d.message || "", d.status || "submitted",
          typeof d.internal_notes === "string" ? d.internal_notes : null,
          json(migrateProfile(d.profile)), data, created, updated]);
      await importApplicationDocuments(connection, d, buckets.applicant);
      await importLegacyResume(connection, d, buckets.resumes);
      for (const item of d.status_history || []) {
        await insert(connection,
          `INSERT INTO application_status_history (application_id, status, actor_type, actor_id, actor_name, created_at)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM application_status_history
             WHERE application_id = ? AND status = ? AND created_at = ?)`,
          [id, item.status || d.status || "submitted", item.actor_type || "legacy",
            ref(item.actor_id), item.actor_name || null, dateValue(item.at) || created,
            id, item.status || d.status || "submitted", dateValue(item.at) || created]);
      }
      if (Array.isArray(d.internal_notes)) {
        for (const note of d.internal_notes) {
          if (!note || !note.note) continue;
          const noteCreated = dateValue(note.at) || created;
          await insert(connection,
            `INSERT INTO application_notes
             (application_id, actor_type, actor_id, actor_name, note, created_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM application_notes
               WHERE application_id = ? AND note = ? AND created_at = ?)`,
            [id, note.actor_type || "legacy", ref(note.actor_id),
              note.actor_name || null, note.note, noteCreated,
              id, note.note, noteCreated]);
        }
      }
      break;
    case "contacts":
      await insert(connection,
        `INSERT INTO contacts (id, name, email, phone, message, status, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), phone=VALUES(phone),
           message=VALUES(message), status=VALUES(status), data=VALUES(data)`,
        [id, d.name || "", d.email || "", d.phone || null, d.message || "", d.status || "new", data, created]);
      break;
    case "partner_inquiries":
      await insert(connection,
        `INSERT INTO partner_inquiries (id, name, email, phone, organization, message, status, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), phone=VALUES(phone),
           organization=VALUES(organization), message=VALUES(message), status=VALUES(status), data=VALUES(data)`,
        [id, d.contact_name || d.name || "", d.email || "", d.phone || null, d.organization || d.company || null,
          d.message || "", d.status || "new", data, created]);
      break;
    case "training_applications":
      await insert(connection,
        `INSERT INTO training_applications (id, name, email, phone, referral_from, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), phone=VALUES(phone),
           referral_from=VALUES(referral_from), status=VALUES(status), data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.name || "", d.email || "", d.phone || null, d.referral_from || null,
          d.status || "new", data, created, updated]);
      break;
    case "hr_accounts":
      await insert(connection,
        `INSERT INTO hr_accounts
         (id, username, email, password_hash, role, active, all_opportunities, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username=VALUES(username), email=VALUES(email),
           password_hash=VALUES(password_hash), role=VALUES(role), active=VALUES(active),
           all_opportunities=VALUES(all_opportunities), data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.username || `${id}@legacy.invalid`, d.email || d.username || `${id}@legacy.invalid`,
          d.password_hash || "", d.role || "reviewer", d.active !== false,
          Boolean(d.all_opportunities), data, created, updated]);
      if (!d.all_opportunities) {
        for (const opportunityId of d.opportunity_ids || []) {
          await insert(connection,
            `INSERT IGNORE INTO hr_opportunity_access (hr_account_id, opportunity_id)
             SELECT ?, id FROM career_opportunities WHERE id = ?`,
            [id, ref(opportunityId)]);
        }
      }
      break;
    case "employees":
      await insert(connection,
        `INSERT INTO employees
         (id, employee_code, name, email, password_hash, active, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE employee_code=VALUES(employee_code), name=VALUES(name),
           email=VALUES(email), password_hash=VALUES(password_hash), active=VALUES(active),
           data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.employee_code || d.employee_id || null, d.name || "",
          d.email || `${id}@legacy.invalid`, d.password_hash || null,
          d.active !== false && d.employment_status !== "inactive", data, created, updated]);
      break;
    case "employee_documents":
      await importEmployeeDocument(connection, d, id, buckets.employee);
      break;
    case "employee_promotions":
      await insert(connection,
        `INSERT INTO employee_promotions (id, employee_id, effective_date, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id), effective_date=VALUES(effective_date),
           status=VALUES(status), data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, ref(d.employee_id), safeDateString(d.effective_date), d.status || "pending", data, created, updated]);
      break;
    case "projects":
      await insert(connection,
        `INSERT INTO projects (id, name, status, start_date, end_date, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status),
           start_date=VALUES(start_date), end_date=VALUES(end_date), data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, d.name || "Untitled project", d.status || "planning",
          safeDateString(d.start_date), safeDateString(d.due_date), data, created, updated]);
      for (const employeeId of d.assigned_employee_ids || []) {
        await insert(connection,
          `INSERT IGNORE INTO project_assignees (project_id, employee_id)
           SELECT ?, id FROM employees WHERE id = ?`,
          [id, ref(employeeId)]);
      }
      break;
    case "project_updates":
      await insert(connection,
        `INSERT INTO project_updates (id, project_id, employee_id, message, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE message=VALUES(message), data=VALUES(data)`,
        [id, ref(d.project_id), ref(d.employee_id) || null, d.message || d.note || "", data, created]);
      break;
    case "leave_requests":
      await insert(connection,
        `INSERT INTO leave_requests (id, employee_id, start_date, end_date, status, reason, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id), start_date=VALUES(start_date),
           end_date=VALUES(end_date), status=VALUES(status), reason=VALUES(reason), data=VALUES(data),
           updated_at=VALUES(updated_at)`,
        [id, ref(d.employee_id), safeDateString(d.start_date), safeDateString(d.end_date),
          d.status || "pending", d.reason || null, data, created, updated]);
      break;
    case "employee_referrals":
      await insert(connection,
        `INSERT INTO employee_referrals
         (id, employee_id, opportunity_id, candidate_name, candidate_email, candidate_phone,
          status, message, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id), opportunity_id=VALUES(opportunity_id),
           candidate_name=VALUES(candidate_name), candidate_email=VALUES(candidate_email),
           candidate_phone=VALUES(candidate_phone), status=VALUES(status), message=VALUES(message),
           data=VALUES(data), updated_at=VALUES(updated_at)`,
        [id, ref(d.employee_id), ref(d.opportunity_id) || "unknown", d.candidate_name || "",
          d.candidate_email || "", d.candidate_phone || null, d.status || "referred",
          d.message || null, data, created, updated]);
      break;
    case "hiring_stages":
      await insert(connection,
        `INSERT INTO hiring_stages (stage_key, label, stage_order, active, hr_editable)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE label=VALUES(label), stage_order=VALUES(stage_order),
           active=VALUES(active), hr_editable=VALUES(hr_editable)`,
        [String(d.key || d._id), d.label || String(d.key || "Stage"),
          Number.isFinite(Number(d.order)) ? Number(d.order) : 100,
          d.active !== false, d.hr_editable !== false]);
      break;
    case "hiring_audit_logs":
      await insert(connection,
        `INSERT INTO hiring_audit_logs
         (application_id, actor_type, actor_id, actor_name, action, record_id, details, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM hiring_audit_logs
           WHERE action = ? AND record_id <=> ? AND created_at = ?)`,
        [ref(d.application_id), d.actor_type || "legacy", ref(d.actor_id),
          d.actor_name || null, d.action || "legacy_import", ref(d.record_id),
          json(d), created, d.action || "legacy_import", ref(d.record_id), created]);
      break;
    default:
      break;
  }
}

async function importApplicationDocuments(connection, application, bucket) {
  if (!application.documents || !application._id) return;
  const applicationId = legacyId(application._id);
  for (const [documentType, value] of Object.entries(application.documents)) {
    const values = Array.isArray(value) ? value : [value];
    for (const [index, item] of values.entries()) {
      if (!item || !item.file_id) continue;
      const normalizedType = documentType === "transcripts"
        ? `transcript-${index}`
        : item.document_type || documentType;
      const fileId = legacyId(item.file_id);
      const [existing] = await connection.execute(
        "SELECT id FROM application_documents WHERE id = ? LIMIT 1",
        [fileId]
      );
      if (existing.length) continue;
      let contents = await downloadGridfs(bucket, item.file_id);
      let encrypted = false;
      let iv = null;
      let tag = null;
      if (normalizedType === "government_id") {
        contents = decryptFernet(contents);
        const protectedData = encrypt(contents);
        contents = protectedData.fileData;
        iv = protectedData.iv;
        tag = protectedData.tag;
        encrypted = true;
      }
      await insert(connection,
        `INSERT INTO application_documents
         (id, application_id, document_type, filename, content_type, file_size,
          encrypted, encryption_iv, encryption_tag, file_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fileId, applicationId, normalizedType, item.filename || "document",
          item.content_type || "application/octet-stream", item.size || contents.length,
          encrypted, iv, tag, contents]);
    }
  }
}

async function importLegacyResume(connection, application, bucket) {
  if (!application.resume_file_id || !application._id) return;
  const applicationId = legacyId(application._id);
  const [existing] = await connection.execute(
    "SELECT id FROM application_documents WHERE application_id = ? AND document_type = 'resume' LIMIT 1",
    [applicationId]
  );
  if (existing.length) return;
  const contents = await downloadGridfs(bucket, application.resume_file_id);
  await insert(connection,
    `INSERT INTO application_documents
     (id, application_id, document_type, filename, content_type, file_size, file_data)
     VALUES (?, ?, 'resume', ?, 'application/pdf', ?, ?)`,
    [legacyId(application.resume_file_id), applicationId,
      application.resume_filename || "resume.pdf",
      application.resume_size || contents.length, contents]);
}

async function importEmployeeDocument(connection, document, id, bucket) {
  if (!document.employee_id || !document.file_id) return;
  const contents = await downloadGridfs(bucket, document.file_id);
  await insert(connection,
    `INSERT INTO employee_documents
     (id, employee_id, filename, content_type, file_size, document_type, file_data, data, uploaded_at)
     VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE filename=VALUES(filename), file_data=VALUES(file_data),
       data=VALUES(data), uploaded_at=VALUES(uploaded_at)`,
    [id, ref(document.employee_id), document.filename || "employee-document.pdf",
      document.size || contents.length, document.document_type || "other",
      contents, json(document), dateValue(document.uploaded_at) || new Date()]);
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  const mongoDbName = process.env.MONGO_DB_NAME;
  if (!mongoUri || !mongoDbName) {
    throw new Error("Set MONGO_URI and MONGO_DB_NAME to run the one-time migration.");
  }
  const mongoClient = new MongoClient(mongoUri);
  const mysqlPool = mysql.createPool({
    ...config.db,
    waitForConnections: true,
    connectionLimit: 3,
    charset: "utf8mb4",
    timezone: "Z",
    ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
  });
  const mongoDb = mongoClient.db(mongoDbName);
  const buckets = {
    applicant: new GridFSBucket(mongoDb, { bucketName: "applicant_documents" }),
    employee: new GridFSBucket(mongoDb, { bucketName: "employee_documents" }),
    resumes: new GridFSBucket(mongoDb, { bucketName: "resumes" }),
  };
  const errors = [];
  let imported = 0;
  try {
    await mongoClient.connect();
    await mysqlPool.query("SELECT 1");
    for (const collectionName of COLLECTIONS) {
      const collection = mongoDb.collection(collectionName);
      const documents = await collection.find({}).toArray();
      console.log(`Importing ${documents.length} ${collectionName} records.`);
      for (const document of documents) {
        const connection = await mysqlPool.getConnection();
        try {
          await connection.beginTransaction();
          await saveLegacy(connection, collectionName, document);
          await importTyped(connection, collectionName, document, buckets);
          await connection.commit();
          imported += 1;
        } catch (error) {
          await connection.rollback();
          const legacyConnection = await mysqlPool.getConnection();
          try {
            await legacyConnection.beginTransaction();
            await saveLegacy(legacyConnection, collectionName, document);
            await legacyConnection.commit();
          } catch (legacyError) {
            await legacyConnection.rollback();
            errors.push({
              collection: collectionName,
              id: legacyId(document._id),
              error: `Legacy preservation failed: ${legacyError.message}`,
            });
          } finally {
            legacyConnection.release();
          }
          errors.push({
            collection: collectionName,
            id: legacyId(document._id),
            error: error.message,
          });
        } finally {
          connection.release();
        }
      }
    }
  } finally {
    await Promise.all([mongoClient.close(), mysqlPool.end()]);
  }
  console.log(`Imported ${imported} records.`);
  if (errors.length) {
    console.error(`${errors.length} records failed; inspect this report before cutover:`);
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("MongoDB migration failed:", error.message);
  process.exitCode = 1;
});
