const express = require("express");
const { z } = require("zod");
const { query, transaction } = require("../db");
const { authenticate } = require("../auth");
const { asyncRoute, HttpError, parsePage, parseJson, requireId, serializeJson } = require("../http");
const { safeFilename } = require("../middleware");
const { decryptBuffer, unprotectProfile } = require("../protected-data");

const router = express.Router();
const hrOnly = authenticate(["hr"]);
const HR_EDITABLE_STAGES = new Set([
  "under_hr_review",
  "shortlisted_for_role",
  "interview_scheduled",
]);

async function assertOpportunityAccess(hr, opportunityId) {
  if (hr.all_opportunities) return;
  const rows = await query(
    "SELECT 1 FROM hr_opportunity_access WHERE hr_account_id = ? AND opportunity_id = ? LIMIT 1",
    [hr.id, opportunityId]
  );
  if (!rows.length) throw new HttpError(404, "Record not found.");
}

async function assertApplicationAccess(hr, applicationId) {
  const [application] = await query(
    "SELECT * FROM applications WHERE id = ? LIMIT 1",
    [applicationId]
  );
  if (!application || application.status === "draft_saved") {
    throw new HttpError(404, "Application not found.");
  }
  await assertOpportunityAccess(hr, application.opportunity_id);
  application.profile = unprotectProfile(parseJson(application.profile));
  application.data = parseJson(application.data);
  return application;
}

router.get(
  "/dashboard",
  hrOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const values = [];
    let access = "";
    if (!req.user.all_opportunities) {
      access = `AND EXISTS (
        SELECT 1 FROM hr_opportunity_access h
        WHERE h.hr_account_id = ? AND h.opportunity_id = a.opportunity_id
      )`;
      values.push(req.user.id);
    }
    const filters = ["a.status <> 'draft_saved'", access];
    if (typeof req.query.status === "string" && req.query.status.length <= 80) {
      filters.push("AND a.status = ?");
      values.push(req.query.status);
    }
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      filters.push("AND (a.name LIKE ? OR a.email LIKE ? OR a.opportunity_title LIKE ?)");
      const term = `%${req.query.q.trim().slice(0, 100)}%`;
      values.push(term, term, term);
    }
    const where = filters.filter(Boolean).join(" ");
    const applications = await query(
      `SELECT a.id, a.opportunity_id, a.opportunity_title, a.name, a.email,
              a.phone, a.status, a.created_at, a.updated_at
       FROM applications a WHERE ${where}
       ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    const referrals = await query(
      `SELECT r.* FROM employee_referrals r
       ${req.user.all_opportunities ? "" : "JOIN hr_opportunity_access h ON h.opportunity_id = r.opportunity_id"}
       WHERE r.status <> 'archived' ${req.user.all_opportunities ? "" : "AND h.hr_account_id = ?"}
       ORDER BY r.created_at DESC LIMIT ?`,
      req.user.all_opportunities ? [limit] : [req.user.id, limit]
    );
    const opportunities = await query(
      `SELECT id, title, opportunity_type, published FROM career_opportunities
       WHERE opportunity_type IN ('job', 'internship')
       ${req.user.all_opportunities ? "" : "AND id IN (SELECT opportunity_id FROM hr_opportunity_access WHERE hr_account_id = ?)"}
       ORDER BY title`,
      req.user.all_opportunities ? [] : [req.user.id]
    );
    res.json({
      data: {
        applications,
        referrals,
        opportunities: opportunities.map((item) => ({ ...item, published: Boolean(item.published) })),
      },
      pagination: { page, limit },
    });
  })
);

router.get(
  "/applications",
  hrOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const where = [];
    const params = [];
    if (!req.user.all_opportunities) {
      where.push("a.opportunity_id IN (SELECT opportunity_id FROM hr_opportunity_access WHERE hr_account_id = ?)");
      params.push(req.user.id);
    }
    if (typeof req.query.status === "string" && req.query.status.length <= 80) {
      where.push("a.status = ?");
      params.push(req.query.status);
    } else {
      where.push("a.status <> 'draft_saved'");
    }
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      where.push("(a.name LIKE ? OR a.email LIKE ? OR a.opportunity_title LIKE ?)");
      const term = `%${req.query.q.trim().slice(0, 100)}%`;
      params.push(term, term, term);
    }
    const rows = await query(
      `SELECT a.id, a.opportunity_id, a.opportunity_title, a.name, a.email,
              a.phone, a.status, a.created_at, a.updated_at
       FROM applications a WHERE ${where.join(" AND ")}
       ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({ data: rows, pagination: { page, limit } });
  })
);

router.get(
  "/applications/:id",
  hrOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "application id");
    const application = await assertApplicationAccess(req.user, id);
    const [documents, history, notes] = await Promise.all([
      query(
        `SELECT id, document_type, filename, content_type, file_size, created_at
         FROM application_documents WHERE application_id = ? ORDER BY created_at`,
        [id]
      ),
      query(
        `SELECT status, actor_type, actor_name, created_at
         FROM application_status_history WHERE application_id = ? ORDER BY created_at`,
        [id]
      ),
      query(
        `SELECT actor_type, actor_name, note, created_at
         FROM application_notes WHERE application_id = ? ORDER BY created_at`,
        [id]
      ),
    ]);
    res.json({ data: { ...application, documents, status_history: history, internal_notes: notes } });
  })
);

router.patch(
  "/applications/:id",
  hrOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "application id");
    const body = z.object({
      status: z.string().trim().min(1).max(80).optional(),
      recommendation: z.enum(["recommend_offer", "recommend_reject", "no_recommendation"]).optional(),
      interview_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
      internal_note: z.string().trim().max(3000).optional(),
    }).strict().parse(req.body);
    const application = await assertApplicationAccess(req.user, id);
    if (!body.status && !body.recommendation && !body.interview_at && !body.internal_note) {
      throw new HttpError(400, "Provide a status, recommendation, interview date, or note update.");
    }
    if (body.status) {
      const [saved] = await query(
        "SELECT active, hr_editable FROM hiring_stages WHERE stage_key = ? LIMIT 1",
        [body.status]
      );
      const editable = saved
        ? Boolean(saved.active) && Boolean(saved.hr_editable)
        : HR_EDITABLE_STAGES.has(body.status);
      if (!editable) {
        throw new HttpError(400, "Select a valid HR-editable application status.");
      }
    }
    await transaction(async (connection) => {
      const data = { ...application.data };
      if (body.recommendation) data.hr_recommendation = body.recommendation;
      if (body.interview_at) {
        const interview = new Date(`${body.interview_at}:00.000Z`);
        if (Number.isNaN(interview.getTime()) || interview.toISOString().slice(0, 16) !== body.interview_at) {
          throw new HttpError(400, "Enter a valid interview date and time.");
        }
        data.interview_at = interview.toISOString();
      }
      if (body.status) {
        await connection.execute(
          "UPDATE applications SET status = ?, data = ? WHERE id = ?",
          [body.status, serializeJson(data), id]
        );
        if (body.status !== application.status) {
          await connection.execute(
            `INSERT INTO application_status_history
             (application_id, status, actor_type, actor_id, actor_name)
             VALUES (?, ?, 'hr', ?, ?)`,
            [id, body.status, req.user.id, req.user.username]
          );
        }
      } else if (body.recommendation || body.interview_at) {
        await connection.execute("UPDATE applications SET data = ? WHERE id = ?", [serializeJson(data), id]);
      }
      if (body.internal_note) {
        await connection.execute(
          `INSERT INTO application_notes
           (application_id, actor_type, actor_id, actor_name, note)
           VALUES (?, 'hr', ?, ?, ?)`,
          [id, req.user.id, req.user.username, body.internal_note]
        );
      }
      await connection.execute(
        `INSERT INTO hiring_audit_logs
         (application_id, actor_type, actor_id, actor_name, action, record_id, details)
         VALUES (?, 'hr', ?, ?, 'application_review_updated', ?, ?)`,
        [id, req.user.id, req.user.username, id, serializeJson(body)]
      );
    });
    res.json({ data: { id, status: body.status || application.status } });
  })
);

router.get(
  "/applications/:id/documents/:documentType",
  hrOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "application id");
    await assertApplicationAccess(req.user, id);
    const [document] = await query(
      `SELECT * FROM application_documents
       WHERE application_id = ? AND document_type = ? LIMIT 1`,
      [id, req.params.documentType]
    );
    if (!document) throw new HttpError(404, "Document not found.");
    let contents = document.file_data;
    if (document.encrypted) {
      contents = decryptBuffer(contents, document.encryption_iv, document.encryption_tag);
    }
    res.set("Content-Type", document.content_type);
    res.set("Content-Disposition", `attachment; filename="${safeFilename(document.filename)}"`);
    res.set("Cache-Control", "private, no-store");
    res.send(contents);
  })
);

router.patch(
  "/referrals/:id/status",
  hrOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "referral id");
    const { status } = z.object({
      status: z.enum(["under_hr_review", "shortlisted_for_role", "interview_scheduled", "not_selected"]),
    }).strict().parse(req.body);
    const [referral] = await query("SELECT * FROM employee_referrals WHERE id = ? LIMIT 1", [id]);
    if (!referral) throw new HttpError(404, "Referral not found.");
    await assertOpportunityAccess(req.user, referral.opportunity_id);
    await transaction(async (connection) => {
      await connection.execute("UPDATE employee_referrals SET status = ? WHERE id = ?", [status, id]);
      await connection.execute(
        `INSERT INTO hiring_audit_logs
         (actor_type, actor_id, actor_name, action, record_id, details)
         VALUES ('hr', ?, ?, 'referral_status_updated', ?, ?)`,
        [req.user.id, req.user.username, id, serializeJson({ status })]
      );
    });
    res.json({ data: { id, status } });
  })
);

router.get(
  "/hiring-stages",
  hrOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      "SELECT stage_key AS `key`, label, stage_order AS `order` FROM hiring_stages WHERE active = TRUE ORDER BY stage_order"
    );
    res.json({
      data: rows.length
        ? rows
        : [
            { key: "submitted", label: "Submitted", order: 10 },
            { key: "under_hr_review", label: "Under HR Review", order: 20 },
            { key: "shortlisted_for_role", label: "Shortlisted for Role", order: 30 },
            { key: "interview_scheduled", label: "Interview Scheduled", order: 40 },
            { key: "final_offer", label: "Final Offer", order: 50 },
            { key: "rejected", label: "Rejected", order: 60 },
          ],
    });
  })
);

module.exports = router;
