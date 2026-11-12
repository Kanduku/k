const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const { query, transaction } = require("../db");
const { authenticate } = require("../auth");
const { memoryUpload, validateUpload, safeFilename } = require("../middleware");
const { asyncRoute, HttpError, parsePage, parseJson, serializeJson, requireId } = require("../http");
const { encryptBuffer, decryptBuffer, protectProfile, unprotectProfile } = require("../protected-data");

const router = express.Router();
const applicantOnly = authenticate(["applicant"]);
const fileFields = memoryUpload.fields([
  { name: "resume", maxCount: 1 },
  { name: "photo", maxCount: 1 },
  { name: "government_id_scan", maxCount: 1 },
  { name: "transcripts", maxCount: 8 },
]);

function submittedFiles(files = {}) {
  return [
    ["resume", "resume"],
    ["photo", "photo"],
    ["government_id_scan", "government_id"],
  ].flatMap(([field, type]) => (files[field] || []).map((file) => ({ field, type, file })))
    .concat((files.transcripts || []).map((file, index) => ({
      field: "transcripts",
      type: "transcript",
      documentType: `transcript-${index}`,
      file,
    })));
}

function validateProfile(profile, submitted) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new HttpError(400, "Profile must be a JSON object.");
  }
  const clean = {};
  for (const [key, value] of Object.entries(profile)) {
    if (!/^[a-z][a-z0-9_]{0,79}$/i.test(key)) continue;
    if (
      key === "government_id_number" &&
      value &&
      typeof value === "object" &&
      value._encrypted === true &&
      typeof value.data === "string" &&
      typeof value.iv === "string" &&
      typeof value.tag === "string"
    ) {
      clean[key] = value;
      continue;
    }
    if (["education", "employment", "certifications", "languages"].includes(key)) {
      if (!Array.isArray(value) || value.length > 8) {
        throw new HttpError(400, `The ${key} section must contain no more than eight records.`);
      }
      clean[key] = value;
    } else if (typeof value === "string") {
      clean[key] = value.trim().slice(0, 4000);
    } else if (typeof value === "boolean" || value === null || typeof value === "number") {
      clean[key] = value;
    } else {
      throw new HttpError(400, `Unsupported profile value for ${key}.`);
    }
  }
  if (clean.government_id_number) {
    Object.assign(clean, protectProfile(clean));
  }
  if (submitted) {
    const required = [
      ["first_name", "Enter your legal first name."],
      ["last_name", "Enter your legal last name."],
      ["date_of_birth", "Enter your date of birth."],
      ["digital_signature", "Provide your digital signature."],
      ["academic_integrity_consent", "Confirm the academic accuracy declaration."],
      ["bgv_consent", "Provide consent for background verification."],
    ];
    const errors = required.filter(([key]) => !clean[key]).map(([, message]) => message);
    if (clean.academic_integrity_consent !== "yes") errors.push("Confirm the academic accuracy declaration.");
    if (clean.bgv_consent !== "yes") errors.push("Provide consent for background verification.");
    if (clean.criminal_declaration === "yes" && !clean.criminal_explanation) {
      errors.push("Provide the requested criminal-record explanation.");
    }
    if (clean.disciplinary_declaration === "yes" && !clean.disciplinary_explanation) {
      errors.push("Provide the requested disciplinary explanation.");
    }
    if (
      clean.same_address !== "yes" &&
      [clean.present_house, clean.present_street, clean.present_city].some(Boolean) &&
      ["present_house", "present_street", "present_city", "present_country"].some((key) => !clean[key])
    ) {
      errors.push("Complete the correspondence address or select same as permanent.");
    }
    if (errors.length) throw new HttpError(400, "Application is incomplete.", "APPLICATION_INVALID");
  }
  return clean;
}

router.get(
  "/me",
  applicantOnly,
  asyncRoute(async (req, res) => {
    res.json({
      data: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
        mobile_verified: Boolean(req.user.mobile_verified),
      },
    });
  })
);

router.get(
  "/opportunities",
  applicantOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const rows = await query(
      `SELECT * FROM career_opportunities
       WHERE published = TRUE AND opportunity_type IN ('job', 'internship')
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        ...parseJson(row.data),
        title: row.title,
        opportunity_type: row.opportunity_type,
        summary: row.summary,
        published: Boolean(row.published),
      })),
      pagination: { page, limit },
    });
  })
);

router.get(
  "/applications",
  applicantOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const rows = await query(
      `SELECT a.id, a.opportunity_id, a.opportunity_title, a.name, a.status, a.profile,
              a.created_at, a.updated_at,
              EXISTS (SELECT 1 FROM application_documents d
                WHERE d.application_id = a.id AND d.document_type = 'resume') AS has_resume
       FROM applications a WHERE a.applicant_id = ?
       ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );
    for (const row of rows) {
      row.profile = unprotectProfile(parseJson(row.profile));
      const profile = row.profile;
      const completion = [
        Boolean(profile.first_name && profile.last_name),
        Boolean(profile.date_of_birth),
        Boolean(profile.permanent_city && profile.permanent_country),
        Array.isArray(profile.education) && profile.education.length > 0,
        Boolean((profile.employment || []).length || profile.technical_skills),
        Boolean(profile.academic_integrity_consent && profile.bgv_consent),
        Boolean(profile.digital_signature && row.has_resume),
      ];
      row.profile_completion = Math.round(completion.filter(Boolean).length * 100 / completion.length);
      delete row.has_resume;
    }
    res.json({
      data: rows,
      pagination: { page, limit },
    });
  })
);

router.get(
  "/applications/:applicationId",
  applicantOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.applicationId, "application id");
    const [application] = await query(
      `SELECT id, opportunity_id, opportunity_title, name, email, phone,
              message, status, profile, created_at, updated_at
       FROM applications WHERE id = ? AND applicant_id = ? LIMIT 1`,
      [id, req.user.id]
    );
    if (!application) throw new HttpError(404, "Application not found.");
    const documents = await query(
      `SELECT id, document_type, filename, content_type, file_size, created_at
       FROM application_documents WHERE application_id = ? ORDER BY created_at`,
      [id]
    );
    application.profile = unprotectProfile(parseJson(application.profile));
    res.json({ data: { ...application, documents } });
  })
);

router.post(
  "/applications/:opportunityId",
  applicantOnly,
  fileFields,
  asyncRoute(async (req, res) => {
    const opportunityId = requireId(req.params.opportunityId, "opportunity id");
    const submitted = req.body.submit !== "false";
    const profileInput = req.body.profile;
    let profile;
    try {
      profile = typeof profileInput === "string" ? JSON.parse(profileInput) : profileInput;
    } catch {
      throw new HttpError(400, "Profile must contain valid JSON.");
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new HttpError(400, "A profile object is required.");
    }
    const cleanProfile = validateProfile(profile, submitted);
    const files = submittedFiles(req.files);
    for (const { file, type } of files) validateUpload(file, type);
    if (submitted && !files.some(({ type }) => type === "resume")) {
      const [existing] = await query(
        `SELECT id FROM applications
         WHERE applicant_id = ? AND opportunity_id = ? LIMIT 1`,
        [req.user.id, opportunityId]
      );
      const oldResume = existing
        ? await query(
            "SELECT id FROM application_documents WHERE application_id = ? AND document_type = 'resume'",
            [existing.id]
          )
        : [];
      if (!oldResume.length) throw new HttpError(400, "Upload your resume before submitting.");
    }
    const [opportunity] = await query(
      `SELECT id, title FROM career_opportunities
       WHERE id = ? AND published = TRUE AND opportunity_type IN ('job', 'internship')
       LIMIT 1`,
      [opportunityId]
    );
    if (!opportunity) throw new HttpError(404, "The selected opportunity is not open.");

    const now = new Date();
    const applicationId = await transaction(async (connection) => {
      const [existingRows] = await connection.execute(
        "SELECT id, status FROM applications WHERE applicant_id = ? AND opportunity_id = ? LIMIT 1 FOR UPDATE",
        [req.user.id, opportunityId]
      );
      const existing = existingRows[0];
      const id = existing?.id || crypto.randomUUID();
      const status = submitted ? "submitted" : "draft_saved";
      const fullName = [
        cleanProfile.first_name,
        cleanProfile.middle_name,
        cleanProfile.last_name,
      ].filter(Boolean).join(" ") || req.user.name;
      if (existing) {
        await connection.execute(
          `UPDATE applications SET opportunity_title = ?, name = ?, email = ?, phone = ?,
             message = ?, status = ?, profile = ?, updated_at = ?
           WHERE id = ? AND applicant_id = ?`,
          [
            opportunity.title,
            fullName,
            req.user.email,
            req.user.phone,
            cleanProfile.message || "",
            status,
            serializeJson(cleanProfile),
            now,
            id,
            req.user.id,
          ]
        );
      } else {
        await connection.execute(
          `INSERT INTO applications
           (id, applicant_id, opportunity_id, opportunity_title, name, email, phone,
            message, status, profile, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            req.user.id,
            opportunityId,
            opportunity.title,
            fullName,
            req.user.email,
            req.user.phone,
            cleanProfile.message || "",
            status,
            serializeJson(cleanProfile),
            now,
            now,
          ]
        );
      }
      if (!existing || existing.status !== status) {
        await connection.execute(
          `INSERT INTO application_status_history
           (application_id, status, actor_type, actor_id, actor_name)
           VALUES (?, ?, 'applicant', ?, ?)`,
          [id, status, req.user.id, req.user.name]
        );
      }
      if (files.some(({ field }) => field === "transcripts")) {
        await connection.execute(
          "DELETE FROM application_documents WHERE application_id = ? AND document_type LIKE 'transcript-%'",
          [id]
        );
      }
      for (const { file, type, documentType } of files) {
        const storedType = documentType || type;
        let contents = file.buffer;
        let encrypted = false;
        let iv = null;
        let tag = null;
        if (type === "government_id") {
          const result = encryptBuffer(contents);
          contents = result.data;
          iv = result.iv;
          tag = result.tag;
          encrypted = true;
        }
        await connection.execute(
          `DELETE FROM application_documents WHERE application_id = ? AND document_type = ?`,
          [id, storedType]
        );
        await connection.execute(
          `INSERT INTO application_documents
           (id, application_id, document_type, filename, content_type, file_size,
            encrypted, encryption_iv, encryption_tag, file_data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            id,
            storedType,
            safeFilename(file.originalname),
            file.mimetype || "application/octet-stream",
            file.size,
            encrypted,
            iv,
            tag,
            contents,
          ]
        );
      }
      if (!existing || existing.status !== status) {
        await connection.execute(
          `INSERT INTO application_status_history
           (application_id, status, actor_type, actor_id, actor_name)
           VALUES (?, ?, 'applicant', ?, ?)`,
          [id, status, req.user.id, req.user.name]
        );
      }
      return id;
    });
    res.status(201).json({ data: { id: applicationId, status: submitted ? "submitted" : "draft_saved" } });
  })
);

router.get(
  "/applications/:applicationId/documents/:documentType",
  applicantOnly,
  asyncRoute(async (req, res) => {
    const applicationId = requireId(req.params.applicationId, "application id");
    const [document] = await query(
      `SELECT d.* FROM application_documents d
       JOIN applications a ON a.id = d.application_id
       WHERE a.id = ? AND a.applicant_id = ? AND d.document_type = ? LIMIT 1`,
      [applicationId, req.user.id, req.params.documentType]
    );
    if (!document) throw new HttpError(404, "Document not found.");
    const contents = document.encrypted
      ? decryptBuffer(document.file_data, document.encryption_iv, document.encryption_tag)
      : document.file_data;
    res.set("Content-Type", document.content_type);
    res.set("Content-Disposition", `attachment; filename="${safeFilename(document.filename)}"`);
    res.set("Cache-Control", "private, no-store");
    res.send(contents);
  })
);

module.exports = router;
