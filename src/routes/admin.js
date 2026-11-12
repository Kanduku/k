const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { z } = require("zod");
const { randomUUID } = require("node:crypto");
const { query, transaction } = require("../db");
const { authenticate } = require("../auth");
const { asyncRoute, HttpError, parsePage, parseJson, requireId, serializeJson } = require("../http");
const { validateUpload, safeFilename } = require("../middleware");
const { decryptBuffer, unprotectProfile } = require("../protected-data");

const router = express.Router();
const adminOnly = authenticate(["admin"]);
const employeePdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});
const opportunityTypes = ["job", "internship", "training"];
const projectStatuses = ["planning", "in_progress", "on_hold", "completed"];
const hiringDefaults = [
  ["submitted", "Submitted", 10, true],
  ["under_hr_review", "Under HR Review", 20, true],
  ["shortlisted_for_role", "Shortlisted for Role", 30, true],
  ["interview_scheduled", "Interview Scheduled", 40, true],
  ["final_offer", "Final Offer", 50, false],
  ["rejected", "Rejected", 60, false],
];

function decodeRow(row) {
  return { ...parseJson(row.data), ...row, id: row.id, data: parseJson(row.data) };
}

function asJson(value) {
  return serializeJson(value || {});
}

function safeEmployeeData(value) {
  const data = parseJson(value);
  delete data.password_hash;
  delete data.password_reset_nonce;
  return data;
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new HttpError(400, `${label} must use YYYY-MM-DD format.`);
  }
  return value;
}

async function audit(connection, req, action, recordId, details = {}) {
  await connection.execute(
    `INSERT INTO hiring_audit_logs
     (actor_type, actor_id, actor_name, action, record_id, details)
     VALUES ('admin', ?, ?, ?, ?, ?)`,
    [req.user.id, req.user.username, action, recordId || null, asJson(details)]
  );
}

router.get(
  "/dashboard",
  adminOnly,
  asyncRoute(async (req, res) => {
    const [counts] = await query(
      `SELECT
        (SELECT COUNT(*) FROM career_opportunities WHERE opportunity_type = 'job') AS jobs_count,
        (SELECT COUNT(*) FROM career_opportunities WHERE opportunity_type = 'internship') AS internships_count,
        (SELECT COUNT(*) FROM applications) AS applications_count,
        (SELECT COUNT(*) FROM contacts) AS contacts_count,
        (SELECT COUNT(*) FROM partner_inquiries) AS partner_inquiries_count,
        (SELECT COUNT(*) FROM partners) AS partners_count,
        (SELECT COUNT(*) FROM projects) AS projects_count,
        (SELECT COUNT(*) FROM employees WHERE active = TRUE) AS employees_count,
        (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') AS leave_requests_count`
    );
    res.json({ data: counts });
  })
);

router.get(
  "/opportunities",
  adminOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const rows = await query(
      `SELECT * FROM career_opportunities
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({ data: rows.map(decodeRow), pagination: { page, limit } });
  })
);

router.post(
  "/opportunities",
  adminOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      opportunity_type: z.enum(opportunityTypes),
      title: z.string().trim().min(1).max(255),
      slug: z.string().trim().max(255).optional().nullable(),
      summary: z.string().max(10000).optional().nullable(),
      published: z.boolean().optional().default(false),
    }).passthrough().parse(req.body);
    const id = randomUUID();
    await query(
      `INSERT INTO career_opportunities
       (id, opportunity_type, title, slug, summary, published, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.opportunity_type,
        body.title,
        body.slug || null,
        body.summary || null,
        body.published,
        asJson(body),
      ]
    );
    res.status(201).json({ data: { id, ...body } });
  })
);

router.patch(
  "/opportunities/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "opportunity id");
    const body = z.object({
      opportunity_type: z.enum(opportunityTypes).optional(),
      title: z.string().trim().min(1).max(255).optional(),
      slug: z.string().trim().max(255).nullable().optional(),
      summary: z.string().max(10000).nullable().optional(),
      published: z.boolean().optional(),
    }).passthrough().parse(req.body);
    const [existing] = await query("SELECT * FROM career_opportunities WHERE id = ? LIMIT 1", [id]);
    if (!existing) throw new HttpError(404, "Opportunity not found.");
    const previousData = parseJson(existing.data);
    const data = { ...previousData, ...body };
    await query(
      `UPDATE career_opportunities
       SET opportunity_type = ?, title = ?, slug = ?, summary = ?, published = ?, data = ?
       WHERE id = ?`,
      [
        data.opportunity_type || existing.opportunity_type,
        data.title || existing.title,
        data.slug ?? existing.slug,
        data.summary ?? existing.summary,
        data.published === undefined ? existing.published : data.published,
        asJson(data),
        id,
      ]
    );
    res.json({ data: { id, ...data } });
  })
);

router.delete(
  "/opportunities/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "opportunity id");
    const [existing] = await query("SELECT id FROM career_opportunities WHERE id = ? LIMIT 1", [id]);
    if (!existing) throw new HttpError(404, "Opportunity not found.");
    await query("UPDATE career_opportunities SET published = FALSE WHERE id = ?", [id]);
    res.status(204).end();
  })
);

router.get(
  "/applications",
  adminOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const rows = await query(
      `SELECT id, applicant_id, opportunity_id, opportunity_title, name, email, phone,
              message, status, internal_notes, profile, created_at, updated_at
       FROM applications ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({
      data: rows.map((row) => ({ ...row, profile: unprotectProfile(parseJson(row.profile)) })),
      pagination: { page, limit },
    });
  })
);

router.get(
  "/applications/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "application id");
    const [application] = await query("SELECT * FROM applications WHERE id = ? LIMIT 1", [id]);
    if (!application) throw new HttpError(404, "Application not found.");
    const [documents, history] = await Promise.all([
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
    ]);
    const notes = await query(
      `SELECT actor_type, actor_name, note, created_at
       FROM application_notes WHERE application_id = ? ORDER BY created_at`,
      [id]
    );
    application.profile = unprotectProfile(parseJson(application.profile));
    application.data = parseJson(application.data);
    res.json({ data: { ...application, documents, status_history: history, internal_note_history: notes } });
  })
);

router.get(
  "/applications/:id/documents/:documentType",
  adminOnly,
  asyncRoute(async (req, res) => {
    const applicationId = requireId(req.params.id, "application id");
    const [document] = await query(
      "SELECT * FROM application_documents WHERE application_id = ? AND document_type = ? LIMIT 1",
      [applicationId, req.params.documentType]
    );
    if (!document) throw new HttpError(404, "Application document not found.");
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
  "/applications/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "application id");
    const body = z.object({
      status: z.string().trim().min(1).max(80).optional(),
      internal_notes: z.string().max(10000).optional(),
      applicant_message: z.string().max(1000).optional(),
    }).strict().parse(req.body);
    if (!body.status && body.internal_notes === undefined && body.applicant_message === undefined) {
      throw new HttpError(400, "Provide a status, internal_notes, or applicant_message update.");
    }
    const [application] = await query("SELECT status FROM applications WHERE id = ? LIMIT 1", [id]);
    if (!application) throw new HttpError(404, "Application not found.");
    if (body.status) {
      const [savedStage] = await query(
        "SELECT active FROM hiring_stages WHERE stage_key = ? LIMIT 1",
        [body.status]
      );
      const active = savedStage
        ? Boolean(savedStage.active)
        : hiringDefaults.some(([key]) => key === body.status);
      if (!active) {
        throw new HttpError(400, "Select an active hiring stage.");
      }
    }
    await transaction(async (connection) => {
      const [rows] = await connection.execute(
        "SELECT data FROM applications WHERE id = ? FOR UPDATE",
        [id]
      );
      const data = { ...parseJson(rows[0].data) };
      if (body.applicant_message !== undefined) data.applicant_message = body.applicant_message;
      if (body.status) {
        await connection.execute(
          "UPDATE applications SET status = ?, data = ? WHERE id = ?",
          [body.status, serializeJson(data), id]
        );
        if (body.status !== application.status) {
          await connection.execute(
            `INSERT INTO application_status_history
             (application_id, status, actor_type, actor_id, actor_name)
             VALUES (?, ?, 'admin', ?, ?)`,
            [id, body.status, req.user.id, req.user.username]
          );
        }
      }
      if (!body.status && body.applicant_message !== undefined) {
        await connection.execute("UPDATE applications SET data = ? WHERE id = ?", [serializeJson(data), id]);
      }
      if (body.internal_notes !== undefined) {
        await connection.execute("UPDATE applications SET internal_notes = ? WHERE id = ?", [body.internal_notes, id]);
      }
      await audit(connection, req, "application_updated", id, body);
    });
    res.json({ data: { id, status: body.status || application.status } });
  })
);

async function getInbox(table, req, res) {
  const { page, limit, offset } = parsePage(req.query);
  const rows = await query(
    `SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  res.json({
    data: rows.map((row) => ({ ...row, data: parseJson(row.data) })),
    pagination: { page, limit },
  });
}

function inboxRoutes(path, table, allowedStatuses) {
  router.get(path, adminOnly, asyncRoute((req, res) => getInbox(table, req, res)));
  router.patch(
    `${path}/:id`,
    adminOnly,
    asyncRoute(async (req, res) => {
      const id = requireId(req.params.id);
      const { status } = z.object({
        status: z.enum(allowedStatuses),
      }).strict().parse(req.body);
      const [existing] = await query(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
      if (!existing) throw new HttpError(404, "Record not found.");
      await query(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, id]);
      res.json({ data: { id, status } });
    })
  );
}

inboxRoutes("/contacts", "contacts", ["new", "read", "archived"]);
inboxRoutes("/partner-inquiries", "partner_inquiries", ["new", "reviewing", "accepted", "rejected", "archived"]);
inboxRoutes("/training-applications", "training_applications", ["new", "reviewing", "contacted", "closed"]);

router.get(
  "/partners",
  adminOnly,
  asyncRoute(async (req, res) => {
    const rows = await query("SELECT * FROM partners ORDER BY created_at DESC");
    res.json({ data: rows.map(decodeRow) });
  })
);

router.post(
  "/partners",
  adminOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(255),
      logo_url: z.string().max(1000).optional().nullable(),
      published: z.boolean().optional().default(false),
    }).passthrough().parse(req.body);
    const id = randomUUID();
    await query(
      "INSERT INTO partners (id, name, logo_url, published, data) VALUES (?, ?, ?, ?, ?)",
      [id, body.name, body.logo_url || null, body.published, asJson(body)]
    );
    res.status(201).json({ data: { id, ...body } });
  })
);

router.patch(
  "/partners/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "partner id");
    const body = z.object({
      name: z.string().trim().min(1).max(255).optional(),
      logo_url: z.string().max(1000).nullable().optional(),
      published: z.boolean().optional(),
    }).passthrough().parse(req.body);
    const [old] = await query("SELECT * FROM partners WHERE id = ? LIMIT 1", [id]);
    if (!old) throw new HttpError(404, "Partner not found.");
    const data = { ...parseJson(old.data), ...body };
    await query(
      "UPDATE partners SET name = ?, logo_url = ?, published = ?, data = ? WHERE id = ?",
      [
        data.name || old.name,
        data.logo_url ?? old.logo_url,
        data.published === undefined ? old.published : data.published,
        asJson(data),
        id,
      ]
    );
    res.json({ data: { id, ...data } });
  })
);

router.delete(
  "/partners/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "partner id");
    const result = await query("DELETE FROM partners WHERE id = ?", [id]);
    if (!result.affectedRows) throw new HttpError(404, "Partner not found.");
    res.status(204).end();
  })
);

router.get(
  "/hr-accounts",
  adminOnly,
  asyncRoute(async (req, res) => {
    const accounts = await query(
      `SELECT id, username, email, role, active, all_opportunities, created_at, updated_at
       FROM hr_accounts ORDER BY username`
    );
    const access = await query("SELECT hr_account_id, opportunity_id FROM hr_opportunity_access");
    const accessMap = new Map();
    for (const row of access) {
      const ids = accessMap.get(row.hr_account_id) || [];
      ids.push(row.opportunity_id);
      accessMap.set(row.hr_account_id, ids);
    }
    res.json({
      data: accounts.map((account) => ({
        ...account,
        active: Boolean(account.active),
        all_opportunities: Boolean(account.all_opportunities),
        opportunity_ids: accessMap.get(account.id) || [],
      })),
    });
  })
);

router.post(
  "/hr-accounts",
  adminOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      username: z.string().trim().email().max(254),
      email: z.string().trim().email().max(254),
      password: z.string().min(12).max(256),
      role: z.enum(["reviewer", "senior_reviewer"]).default("reviewer"),
      active: z.boolean().default(true),
      all_opportunities: z.boolean().default(false),
      opportunity_ids: z.array(z.string().min(1).max(36)).max(500).default([]),
    }).strict().parse(req.body);
    const id = randomUUID();
    const passwordHash = await bcrypt.hash(body.password, 12);
    await transaction(async (connection) => {
      await connection.execute(
        `INSERT INTO hr_accounts
         (id, username, email, password_hash, role, active, all_opportunities)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, body.username.toLowerCase(), body.email.toLowerCase(), passwordHash, body.role, body.active, body.all_opportunities]
      );
      if (!body.all_opportunities) {
        for (const opportunityId of new Set(body.opportunity_ids)) {
          await connection.execute(
            "INSERT INTO hr_opportunity_access (hr_account_id, opportunity_id) VALUES (?, ?)",
            [id, requireId(opportunityId, "opportunity id")]
          );
        }
      }
    });
    res.status(201).json({
      data: {
        id,
        username: body.username.toLowerCase(),
        email: body.email.toLowerCase(),
        role: body.role,
        active: body.active,
        all_opportunities: body.all_opportunities,
        opportunity_ids: body.all_opportunities ? [] : [...new Set(body.opportunity_ids)],
      },
    });
  })
);

router.patch(
  "/hr-accounts/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "HR account id");
    const body = z.object({
      username: z.string().trim().email().max(254).optional(),
      email: z.string().trim().email().max(254).optional(),
      password: z.string().min(12).max(256).optional(),
      role: z.enum(["reviewer", "senior_reviewer"]).optional(),
      active: z.boolean().optional(),
      all_opportunities: z.boolean().optional(),
      opportunity_ids: z.array(z.string().min(1).max(36)).max(500).optional(),
    }).strict().parse(req.body);
    if (!Object.keys(body).length) throw new HttpError(400, "Provide at least one field to update.");
    const [old] = await query("SELECT * FROM hr_accounts WHERE id = ? LIMIT 1", [id]);
    if (!old) throw new HttpError(404, "HR account not found.");
    const fields = [];
    const values = [];
    for (const field of ["username", "email", "role", "active", "all_opportunities"]) {
      if (body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(typeof body[field] === "string" ? body[field].toLowerCase() : body[field]);
      }
    }
    if (body.password) {
      fields.push("password_hash = ?");
      values.push(await bcrypt.hash(body.password, 12));
    }
    await transaction(async (connection) => {
      if (fields.length) {
        await connection.execute(`UPDATE hr_accounts SET ${fields.join(", ")} WHERE id = ?`, [...values, id]);
      }
      if (body.opportunity_ids !== undefined || body.all_opportunities !== undefined) {
        await connection.execute("DELETE FROM hr_opportunity_access WHERE hr_account_id = ?", [id]);
        if (!body.all_opportunities) {
          for (const opportunityId of new Set(body.opportunity_ids || [])) {
            await connection.execute(
              "INSERT INTO hr_opportunity_access (hr_account_id, opportunity_id) VALUES (?, ?)",
              [id, requireId(opportunityId, "opportunity id")]
            );
          }
        }
      }
    });
    res.json({ data: { id, updated: true } });
  })
);

router.get(
  "/hiring-stages",
  adminOnly,
  asyncRoute(async (req, res) => {
    const saved = await query("SELECT * FROM hiring_stages ORDER BY stage_order");
    const byKey = new Map(saved.map((row) => [row.stage_key, row]));
    const data = hiringDefaults.map(([key, label, order, hrEditable]) => {
      const row = byKey.get(key);
      byKey.delete(key);
      return {
        key,
        label: row?.label || label,
        order: row?.stage_order ?? order,
        active: row ? Boolean(row.active) : true,
        hr_editable: row ? Boolean(row.hr_editable) : hrEditable,
      };
    });
    for (const row of byKey.values()) {
      data.push({
        key: row.stage_key,
        label: row.label,
        order: row.stage_order,
        active: Boolean(row.active),
        hr_editable: Boolean(row.hr_editable),
      });
    }
    res.json({ data: data.sort((a, b) => a.order - b.order) });
  })
);

router.put(
  "/hiring-stages",
  adminOnly,
  asyncRoute(async (req, res) => {
    const stages = z.array(z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
      label: z.string().trim().min(1).max(120),
      order: z.number().int().min(0).max(10000),
      active: z.boolean(),
      hr_editable: z.boolean(),
    }).strict()).min(1).max(100).parse(req.body.stages);
    if (new Set(stages.map((stage) => stage.key)).size !== stages.length) {
      throw new HttpError(400, "Hiring stage keys must be unique.");
    }
    await transaction(async (connection) => {
      for (const stage of stages) {
        await connection.execute(
          `INSERT INTO hiring_stages (stage_key, label, stage_order, active, hr_editable)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE label = VALUES(label), stage_order = VALUES(stage_order),
             active = VALUES(active), hr_editable = VALUES(hr_editable)`,
          [stage.key, stage.label, stage.order, stage.active, stage.hr_editable]
        );
      }
    });
    res.json({ data: stages });
  })
);

router.get(
  "/employees",
  adminOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const rows = await query(
      `SELECT id, employee_code, name, email, active, data, created_at, updated_at
       FROM employees ORDER BY name LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({
      data: rows.map((row) => ({ ...safeEmployeeData(row.data), ...row, id: row.id, data: safeEmployeeData(row.data), active: Boolean(row.active) })),
      pagination: { page, limit },
    });
  })
);

router.get(
  "/employees/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "employee id");
    const [employee] = await query(
      `SELECT id, employee_code, name, email, active, data, created_at, updated_at
       FROM employees WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!employee) throw new HttpError(404, "Employee not found.");
    const [projects, documents, promotions, leaveRequests] = await Promise.all([
      query(
        `SELECT p.* FROM projects p
         JOIN project_assignees a ON a.project_id = p.id
         WHERE a.employee_id = ? ORDER BY p.updated_at DESC`,
        [id]
      ),
      query(
        `SELECT id, filename, content_type, file_size, document_type, data, uploaded_at
         FROM employee_documents WHERE employee_id = ? ORDER BY uploaded_at DESC`,
        [id]
      ),
      query("SELECT * FROM employee_promotions WHERE employee_id = ? ORDER BY created_at DESC LIMIT 50", [id]),
      query("SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY created_at DESC LIMIT 50", [id]),
    ]);
    res.json({
      data: {
        ...employee,
        data: safeEmployeeData(employee.data),
        active: Boolean(employee.active),
        projects: projects.map((row) => ({ ...row, data: parseJson(row.data) })),
        documents: documents.map((row) => ({ ...row, data: parseJson(row.data) })),
        promotions: promotions.map((row) => ({ ...row, data: parseJson(row.data) })),
        leave_requests: leaveRequests.map((row) => ({ ...row, data: parseJson(row.data) })),
      },
    });
  })
);

router.post(
  "/employees",
  adminOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      employee_code: z.string().trim().max(80).optional().nullable(),
      name: z.string().trim().min(1).max(160),
      email: z.string().trim().email().max(254),
      password: z.string().min(12).max(256),
      active: z.boolean().default(true),
      employment_status: z.enum(["active", "probation", "on_leave", "notice_period", "inactive"]).default("active"),
    }).passthrough().parse(req.body);
    const id = randomUUID();
    const passwordHash = await bcrypt.hash(body.password, 12);
    const { password: omittedPassword, ...employeeData } = body;
    const active = body.employment_status === "inactive" ? false : body.active;
    employeeData.active = active;
    await query(
      `INSERT INTO employees (id, employee_code, name, email, password_hash, active, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.employee_code || null,
        body.name,
        body.email.toLowerCase(),
        passwordHash,
        active,
        asJson(employeeData),
      ]
    );
    res.status(201).json({ data: { id, name: body.name, email: body.email.toLowerCase(), active } });
  })
);

router.patch(
  "/employees/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "employee id");
    const body = z.object({
      employee_code: z.string().trim().max(80).nullable().optional(),
      name: z.string().trim().min(1).max(160).optional(),
      email: z.string().trim().email().max(254).optional(),
      password: z.string().min(12).max(256).optional(),
      active: z.boolean().optional(),
      employment_status: z.enum(["active", "probation", "on_leave", "notice_period", "inactive"]).optional(),
    }).passthrough().parse(req.body);
    const [old] = await query("SELECT * FROM employees WHERE id = ? LIMIT 1", [id]);
    if (!old) throw new HttpError(404, "Employee not found.");
    const { password: omittedPassword, ...employeeData } = body;
    if (body.employment_status === "inactive") employeeData.active = false;
    const data = { ...parseJson(old.data), ...employeeData };
    const active = body.employment_status === "inactive"
      ? false
      : body.active === undefined
        ? Boolean(old.active)
        : body.active;
    const values = [
      body.employee_code === undefined ? old.employee_code : body.employee_code,
      body.name || old.name,
      body.email ? body.email.toLowerCase() : old.email,
      active,
      asJson(data),
    ];
    let passwordSql = "";
    if (body.password) {
      passwordSql = ", password_hash = ?";
      values.push(await bcrypt.hash(body.password, 12));
    }
    values.push(id);
    await query(
      `UPDATE employees
       SET employee_code = ?, name = ?, email = ?, active = ?, data = ?${passwordSql}
       WHERE id = ?`,
      values
    );
    res.json({ data: { id, updated: true } });
  })
);

router.get(
  "/projects",
  adminOnly,
  asyncRoute(async (req, res) => {
    const rows = await query("SELECT * FROM projects ORDER BY updated_at DESC");
    const assigned = await query("SELECT project_id, employee_id FROM project_assignees");
    const byProject = new Map();
    for (const row of assigned) {
      const ids = byProject.get(row.project_id) || [];
      ids.push(row.employee_id);
      byProject.set(row.project_id, ids);
    }
    res.json({
      data: rows.map((row) => ({
        ...decodeRow(row),
        assigned_employee_ids: byProject.get(row.id) || [],
      })),
    });
  })
);

router.get(
  "/projects/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "project id");
    const [project] = await query("SELECT * FROM projects WHERE id = ? LIMIT 1", [id]);
    if (!project) throw new HttpError(404, "Project not found.");
    const [assigned, updates] = await Promise.all([
      query(
        `SELECT e.id, e.name, e.email FROM project_assignees a
         JOIN employees e ON e.id = a.employee_id WHERE a.project_id = ? ORDER BY e.name`,
        [id]
      ),
      query("SELECT * FROM project_updates WHERE project_id = ? ORDER BY created_at DESC LIMIT 100", [id]),
    ]);
    res.json({
      data: {
        ...project,
        data: parseJson(project.data),
        assigned_employees: assigned,
        updates: updates.map((row) => ({ ...row, data: parseJson(row.data) })),
      },
    });
  })
);

router.post(
  "/projects",
  adminOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(160),
      description: z.string().max(10000).optional().default(""),
      status: z.enum(projectStatuses).default("planning"),
      progress: z.number().int().min(0).max(100).default(0),
      start_date: z.string().optional().nullable(),
      due_date: z.string().optional().nullable(),
      assigned_employee_ids: z.array(z.string()).max(500).default([]),
    }).passthrough().parse(req.body);
    const id = randomUUID();
    const startDate = optionalDate(body.start_date, "Start date");
    const endDate = optionalDate(body.due_date, "Due date");
    if (startDate && endDate && endDate < startDate) {
      throw new HttpError(400, "The due date cannot be before the start date.");
    }
    await transaction(async (connection) => {
      await connection.execute(
        `INSERT INTO projects (id, name, status, start_date, end_date, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, body.name, body.status, startDate, endDate, asJson(body)]
      );
      for (const employeeId of new Set(body.assigned_employee_ids)) {
        const validId = requireId(employeeId, "employee id");
        const [employee] = await connection.execute(
          "SELECT id FROM employees WHERE id = ? AND active = TRUE",
          [validId]
        );
        if (!employee.length) throw new HttpError(400, "Only active employees can be assigned.");
        await connection.execute(
          "INSERT INTO project_assignees (project_id, employee_id) VALUES (?, ?)",
          [id, validId]
        );
      }
      await connection.execute(
        `INSERT INTO project_updates (id, project_id, message, data)
         VALUES (?, ?, 'Project created', ?)`,
        [
          randomUUID(),
          id,
          asJson({
            task: "Project created",
            task_status: body.status,
            progress: body.progress,
            notes: "Initial project setup.",
            actor_name: req.user.username,
          }),
        ]
      );
    });
    res.status(201).json({ data: { id, ...body } });
  })
);

router.patch(
  "/projects/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "project id");
    const body = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      description: z.string().max(10000).optional(),
      status: z.enum(projectStatuses).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      start_date: z.string().nullable().optional(),
      due_date: z.string().nullable().optional(),
      assigned_employee_ids: z.array(z.string()).max(500).optional(),
    }).passthrough().parse(req.body);
    const [old] = await query("SELECT * FROM projects WHERE id = ? LIMIT 1", [id]);
    if (!old) throw new HttpError(404, "Project not found.");
    const oldData = parseJson(old.data);
    const data = { ...oldData, ...body };
    const startDate = optionalDate(body.start_date === undefined ? old.start_date : body.start_date, "Start date");
    const endDate = optionalDate(body.due_date === undefined ? old.end_date : body.due_date, "Due date");
    if (startDate && endDate && endDate < startDate) {
      throw new HttpError(400, "The due date cannot be before the start date.");
    }
    await transaction(async (connection) => {
      await connection.execute(
        `UPDATE projects SET name = ?, status = ?, start_date = ?, end_date = ?, data = ?
         WHERE id = ?`,
        [
          data.name || old.name,
          data.status || old.status,
          startDate,
          endDate,
          asJson(data),
          id,
        ]
      );
      if (body.assigned_employee_ids !== undefined) {
        await connection.execute("DELETE FROM project_assignees WHERE project_id = ?", [id]);
        for (const employeeId of new Set(body.assigned_employee_ids)) {
          const validId = requireId(employeeId, "employee id");
          const [employee] = await connection.execute(
            "SELECT id FROM employees WHERE id = ? AND active = TRUE",
            [validId]
          );
          if (!employee.length) throw new HttpError(400, "Only active employees can be assigned.");
          await connection.execute(
            "INSERT INTO project_assignees (project_id, employee_id) VALUES (?, ?)",
            [id, validId]
          );
        }
      }
      await connection.execute(
        `INSERT INTO project_updates (id, project_id, message, data)
         VALUES (?, ?, 'Project details updated', ?)`,
        [
          randomUUID(),
          id,
          asJson({
            task: "Project details updated",
            task_status: data.status || old.status,
            progress: data.progress ?? oldData.progress ?? 0,
            notes: "Administrator updated project details or assignments.",
            actor_name: req.user.username,
          }),
        ]
      );
    });
    res.json({ data: { id, ...data } });
  })
);

router.delete(
  "/projects/:id",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "project id");
    const result = await query("DELETE FROM projects WHERE id = ?", [id]);
    if (!result.affectedRows) throw new HttpError(404, "Project not found.");
    res.status(204).end();
  })
);

router.get(
  "/leave-requests",
  adminOnly,
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const rows = await query(
      `SELECT l.*, e.name AS employee_name, e.email AS employee_email
       FROM leave_requests l JOIN employees e ON e.id = l.employee_id
       ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })), pagination: { page, limit } });
  })
);

router.patch(
  "/leave-requests/:id/status",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "leave request id");
    const { status, decision_note } = z.object({
      status: z.enum(["approved", "rejected"]),
      decision_note: z.string().max(2000).optional().default(""),
    }).strict().parse(req.body);
    const [old] = await query("SELECT data FROM leave_requests WHERE id = ? LIMIT 1", [id]);
    if (!old) throw new HttpError(404, "Leave request not found.");
    const data = { ...parseJson(old.data), decision_note };
    await query(
      "UPDATE leave_requests SET status = ?, data = ? WHERE id = ?",
      [status, serializeJson(data), id]
    );
    res.json({ data: { id, status } });
  })
);

router.get(
  "/project-calendar",
  adminOnly,
  asyncRoute(async (req, res) => {
    const today = new Date();
    const year = Number.parseInt(req.query.year || String(today.getUTCFullYear()), 10);
    const month = Number.parseInt(req.query.month || String(today.getUTCMonth() + 1), 10);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new HttpError(400, "Choose a valid calendar month.");
    }
    const start = `${year}-${String(month).padStart(2, "0")}-01 00:00:00`;
    const nextMonth = month === 12 ? `${year + 1}-01-01 00:00:00` : `${year}-${String(month + 1).padStart(2, "0")}-01 00:00:00`;
    const updates = await query(
      `SELECT u.*, p.name AS project_name
       FROM project_updates u LEFT JOIN projects p ON p.id = u.project_id
       WHERE u.created_at >= ? AND u.created_at < ?
       ORDER BY u.created_at`,
      [start, nextMonth]
    );
    res.json({ data: updates.map((update) => ({ ...update, data: parseJson(update.data) })) });
  })
);

router.get(
  "/employee-referrals",
  adminOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      `SELECT r.*, e.name AS employee_name
       FROM employee_referrals r JOIN employees e ON e.id = r.employee_id
       ORDER BY r.created_at DESC`
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })) });
  })
);

router.patch(
  "/employee-referrals/:id/status",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "referral id");
    const { status } = z.object({
      status: z.enum(["referred", "under_hr_review", "shortlisted_for_role", "interview_scheduled", "hired", "not_selected", "archived"]),
    }).strict().parse(req.body);
    const [existing] = await query("SELECT id FROM employee_referrals WHERE id = ? LIMIT 1", [id]);
    if (!existing) throw new HttpError(404, "Referral not found.");
    await query("UPDATE employee_referrals SET status = ? WHERE id = ?", [status, id]);
    res.json({ data: { id, status } });
  })
);

router.get(
  "/employee-promotions",
  adminOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      `SELECT p.*, e.name AS employee_name, e.email AS employee_email
       FROM employee_promotions p JOIN employees e ON e.id = p.employee_id
       ORDER BY p.created_at DESC`
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })) });
  })
);

router.post(
  "/employee-promotions",
  adminOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      employee_id: z.string(),
      effective_date: z.string().optional().nullable(),
      status: z.enum(["proposed", "under_review", "approved", "rejected", "effective"]).default("proposed"),
    }).passthrough().parse(req.body);
    const id = randomUUID();
    await query(
      `INSERT INTO employee_promotions (id, employee_id, effective_date, status, data)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        requireId(body.employee_id, "employee id"),
        optionalDate(body.effective_date, "Effective date"),
        body.status,
        asJson(body),
      ]
    );
    res.status(201).json({ data: { id, ...body } });
  })
);

router.patch(
  "/employee-promotions/:id/status",
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "promotion id");
    const { status, effective_date } = z.object({
      status: z.enum(["proposed", "under_review", "approved", "rejected", "effective"]),
      effective_date: z.string().nullable().optional(),
    }).strict().parse(req.body);
    const [existing] = await query("SELECT data FROM employee_promotions WHERE id = ? LIMIT 1", [id]);
    if (!existing) throw new HttpError(404, "Promotion not found.");
    const data = { ...parseJson(existing.data), status };
    const date = optionalDate(effective_date, "Effective date");
    await query(
      "UPDATE employee_promotions SET status = ?, effective_date = COALESCE(?, effective_date), data = ? WHERE id = ?",
      [status, date, asJson(data), id]
    );
    res.json({ data: { id, status, effective_date: date } });
  })
);

router.post(
  "/employees/:employeeId/documents",
  adminOnly,
  employeePdfUpload.single("file"),
  asyncRoute(async (req, res) => {
    const employeeId = requireId(req.params.employeeId, "employee id");
    if (!req.file) throw new HttpError(400, "Choose a PDF document.");
    validateUpload(req.file, "employee_pdf");
    const body = z.object({
      document_type: z.enum([
        "offer_letter",
        "employment_contract",
        "promotion_letter",
        "identity_document",
        "certificate",
        "other",
      ]),
      label: z.string().trim().min(1).max(160),
    }).parse(req.body);
    const [employee] = await query("SELECT id FROM employees WHERE id = ? LIMIT 1", [employeeId]);
    if (!employee) throw new HttpError(404, "Employee not found.");
    const id = randomUUID();
    await query(
      `INSERT INTO employee_documents
       (id, employee_id, filename, content_type, file_size, document_type, file_data, data)
       VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?)`,
      [
        id,
        employeeId,
        safeFilename(req.file.originalname),
        req.file.size,
        body.document_type,
        req.file.buffer,
        asJson({ label: body.label, uploaded_by: req.user.username }),
      ]
    );
    res.status(201).json({ data: { id, employee_id: employeeId, ...body } });
  })
);

router.get(
  "/employees/:employeeId/documents",
  adminOnly,
  asyncRoute(async (req, res) => {
    const employeeId = requireId(req.params.employeeId, "employee id");
    const rows = await query(
      `SELECT id, employee_id, filename, content_type, file_size, document_type, data, uploaded_at
       FROM employee_documents WHERE employee_id = ? ORDER BY uploaded_at DESC`,
      [employeeId]
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })) });
  })
);

router.get(
  "/employees/:employeeId/documents/:documentId",
  adminOnly,
  asyncRoute(async (req, res) => {
    const employeeId = requireId(req.params.employeeId, "employee id");
    const documentId = requireId(req.params.documentId, "document id");
    const [document] = await query(
      "SELECT * FROM employee_documents WHERE id = ? AND employee_id = ? LIMIT 1",
      [documentId, employeeId]
    );
    if (!document) throw new HttpError(404, "Employee document not found.");
    res.set("Content-Type", document.content_type);
    res.set("Content-Disposition", `attachment; filename="${safeFilename(document.filename)}"`);
    res.set("Cache-Control", "private, no-store");
    res.send(document.file_data);
  })
);

router.delete(
  "/employees/:employeeId/documents/:documentId",
  adminOnly,
  asyncRoute(async (req, res) => {
    const employeeId = requireId(req.params.employeeId, "employee id");
    const documentId = requireId(req.params.documentId, "document id");
    const result = await query(
      "DELETE FROM employee_documents WHERE id = ? AND employee_id = ?",
      [documentId, employeeId]
    );
    if (!result.affectedRows) throw new HttpError(404, "Employee document not found.");
    res.status(204).end();
  })
);

module.exports = router;
