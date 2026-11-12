const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { z } = require("zod");
const { randomUUID } = require("node:crypto");
const { query, transaction } = require("../db");
const { authenticate } = require("../auth");
const { asyncRoute, HttpError, parseJson, requireId, serializeJson } = require("../http");
const { validateUpload, safeFilename } = require("../middleware");

const router = express.Router();
const employeeOnly = authenticate(["employee"]);
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function employeeData(value) {
  const data = parseJson(value);
  delete data.password_hash;
  delete data.password_reset_nonce;
  return data;
}

async function getAssignedProject(employeeId, projectId) {
  const [project] = await query(
    `SELECT p.* FROM projects p
     JOIN project_assignees a ON a.project_id = p.id
     WHERE p.id = ? AND a.employee_id = ? LIMIT 1`,
    [projectId, employeeId]
  );
  if (!project) throw new HttpError(404, "Project not found.");
  project.data = parseJson(project.data);
  return project;
}

router.get(
  "/me",
  employeeOnly,
  asyncRoute(async (req, res) => {
    res.json({
      data: {
        id: req.user.id,
        employee_code: req.user.employee_code,
        name: req.user.name,
        email: req.user.email,
        active: Boolean(req.user.active),
        ...employeeData(req.user.data),
      },
    });
  })
);

router.get(
  "/profile",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const [projects, leaveRequests, documents, promotions] = await Promise.all([
      query(
        `SELECT p.* FROM projects p JOIN project_assignees a ON a.project_id = p.id
         WHERE a.employee_id = ? ORDER BY p.updated_at DESC`,
        [req.user.id]
      ),
      query(
        "SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY created_at DESC LIMIT 10",
        [req.user.id]
      ),
      query(
        `SELECT id, filename, content_type, file_size, document_type, data, uploaded_at
         FROM employee_documents WHERE employee_id = ? ORDER BY uploaded_at DESC`,
        [req.user.id]
      ),
      query(
        "SELECT * FROM employee_promotions WHERE employee_id = ? ORDER BY created_at DESC LIMIT 50",
        [req.user.id]
      ),
    ]);
    res.json({
      data: {
        employee: {
          id: req.user.id,
          employee_code: req.user.employee_code,
          name: req.user.name,
          email: req.user.email,
          ...employeeData(req.user.data),
        },
        projects: projects.map((row) => ({ ...row, data: parseJson(row.data) })),
        leave_requests: leaveRequests.map((row) => ({ ...row, data: parseJson(row.data) })),
        documents: documents.map((row) => ({ ...row, data: parseJson(row.data) })),
        promotions: promotions.map((row) => ({ ...row, data: parseJson(row.data) })),
      },
    });
  })
);

router.patch(
  "/me",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      phone: z.string().trim().max(40).optional(),
      alternate_phone: z.string().trim().max(40).optional(),
      address: z.string().trim().max(1000).optional(),
      emergency_contact_name: z.string().trim().max(160).optional(),
      emergency_contact_phone: z.string().trim().max(40).optional(),
    }).strict().parse(req.body);
    if (!Object.keys(body).length) throw new HttpError(400, "Provide at least one profile field.");
    const data = { ...employeeData(req.user.data), ...body };
    await query("UPDATE employees SET data = ? WHERE id = ?", [serializeJson(data), req.user.id]);
    res.json({ data: { id: req.user.id, ...body } });
  })
);

router.patch(
  "/password",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      current_password: z.string().min(1).max(256),
      new_password: z.string().min(12).max(256),
    }).strict().parse(req.body);
    if (!(await bcrypt.compare(body.current_password, req.user.password_hash || ""))) {
      throw new HttpError(400, "The current password is incorrect.", "INVALID_PASSWORD");
    }
    const passwordHash = await bcrypt.hash(body.new_password, 12);
    await query("UPDATE employees SET password_hash = ? WHERE id = ?", [passwordHash, req.user.id]);
    res.json({ message: "Password updated." });
  })
);

router.get(
  "/dashboard",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const [projects, leaveRequests, referrals] = await Promise.all([
      query(
        `SELECT p.* FROM projects p
         JOIN project_assignees a ON a.project_id = p.id
         WHERE a.employee_id = ? ORDER BY p.updated_at DESC`,
        [req.user.id]
      ),
      query(
        "SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY created_at DESC LIMIT 5",
        [req.user.id]
      ),
      query(
        "SELECT * FROM employee_referrals WHERE employee_id = ? ORDER BY created_at DESC LIMIT 10",
        [req.user.id]
      ),
    ]);
    res.json({
      data: {
        projects: projects.map((project) => ({ ...project, data: parseJson(project.data) })),
        leave_requests: leaveRequests.map((item) => ({ ...item, data: parseJson(item.data) })),
        referrals: referrals.map((item) => ({ ...item, data: parseJson(item.data) })),
      },
    });
  })
);

router.get(
  "/projects",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      `SELECT p.* FROM projects p JOIN project_assignees a ON a.project_id = p.id
       WHERE a.employee_id = ? ORDER BY p.updated_at DESC`,
      [req.user.id]
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })) });
  })
);

router.get(
  "/projects/:id",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "project id");
    const project = await getAssignedProject(req.user.id, id);
    const updates = await query(
      "SELECT id, employee_id, message, data, created_at FROM project_updates WHERE project_id = ? ORDER BY created_at DESC",
      [id]
    );
    res.json({
      data: {
        ...project,
        updates: updates.map((item) => ({ ...item, data: parseJson(item.data) })),
      },
    });
  })
);

router.post(
  "/projects/:id/updates",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "project id");
    await getAssignedProject(req.user.id, id);
    const body = z.object({
      message: z.string().trim().max(4000).optional().default(""),
      task: z.string().trim().min(1).max(160).optional(),
      task_status: z.enum(["in_progress", "blocked", "completed"]).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      notes: z.string().max(5000).optional(),
    }).strict().parse(req.body);
    if (!body.message && !body.task) {
      throw new HttpError(400, "A project update task or message is required.");
    }
    const updateId = randomUUID();
    await transaction(async (connection) => {
      await connection.execute(
        "INSERT INTO project_updates (id, project_id, employee_id, message, data) VALUES (?, ?, ?, ?, ?)",
        [updateId, id, req.user.id, body.message || body.task, serializeJson(body)]
      );
      if (body.progress !== undefined) {
        const [projectRows] = await connection.execute("SELECT data FROM projects WHERE id = ? FOR UPDATE", [id]);
        const data = { ...parseJson(projectRows[0].data) };
        data.progress = body.progress;
        await connection.execute("UPDATE projects SET data = ? WHERE id = ?", [serializeJson(data), id]);
      }
    });
    res.status(201).json({ data: { id: updateId, project_id: id, ...body } });
  })
);

router.get(
  "/leave-requests",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      "SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })) });
  })
);

router.post(
  "/leave-requests",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().trim().min(1).max(3000),
      leave_type: z.enum(["annual", "sick", "personal", "other"]),
    }).passthrough().parse(req.body);
    if (!validDate(body.start_date) || !validDate(body.end_date)) {
      throw new HttpError(400, "Enter valid leave dates.");
    }
    if (body.end_date < body.start_date) {
      throw new HttpError(400, "The end date cannot be before the start date.");
    }
    const id = randomUUID();
    await query(
      `INSERT INTO leave_requests (id, employee_id, start_date, end_date, reason, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, body.start_date, body.end_date, body.reason, serializeJson(body)]
    );
    res.status(201).json({ data: { id, status: "pending" } });
  })
);

router.delete(
  "/leave-requests/:id",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "leave request id");
    const result = await query(
      "DELETE FROM leave_requests WHERE id = ? AND employee_id = ? AND status = 'pending'",
      [id, req.user.id]
    );
    if (!result.affectedRows) {
      throw new HttpError(404, "Only your pending leave requests can be cancelled.");
    }
    res.status(204).end();
  })
);

router.get(
  "/referrals",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      "SELECT * FROM employee_referrals WHERE employee_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ data: rows.map((row) => ({ ...row, data: parseJson(row.data) })) });
  })
);

router.post(
  "/referrals",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const body = z.object({
      opportunity_id: z.string().min(1).max(36),
      candidate_name: z.string().trim().min(1).max(160),
      candidate_email: z.string().trim().email().max(254),
      candidate_phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,24}$/),
      candidate_consent: z.literal(true),
      message: z.string().max(4000).optional().default(""),
    }).strict().parse(req.body);
    const opportunityId = requireId(body.opportunity_id, "opportunity id");
    const [opportunity] = await query(
      `SELECT id, title FROM career_opportunities
       WHERE id = ? AND published = TRUE AND opportunity_type IN ('job', 'internship')`,
      [opportunityId]
    );
    if (!opportunity) throw new HttpError(400, "That role is no longer open.");
    const existing = await query(
      "SELECT id FROM employee_referrals WHERE candidate_email = ? AND opportunity_id = ? LIMIT 1",
      [body.candidate_email.toLowerCase(), opportunityId]
    );
    if (existing.length) throw new HttpError(409, "This candidate has already been referred for that role.");
    const id = randomUUID();
    await query(
      `INSERT INTO employee_referrals
       (id, employee_id, opportunity_id, candidate_name, candidate_email,
        candidate_phone, status, message, data)
       VALUES (?, ?, ?, ?, ?, ?, 'referred', ?, ?)`,
      [
        id,
        req.user.id,
        opportunityId,
        body.candidate_name,
        body.candidate_email.toLowerCase(),
        body.candidate_phone,
        body.message,
        serializeJson({ ...body, opportunity_title: opportunity.title }),
      ]
    );
    res.status(201).json({ data: { id, status: "referred" } });
  })
);

router.get(
  "/documents",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const rows = await query(
      `SELECT id, filename, content_type, file_size, document_type, data, uploaded_at
       FROM employee_documents WHERE employee_id = ? ORDER BY uploaded_at DESC`,
      [req.user.id]
    );
    res.json({
      data: rows.map((row) => ({
        ...row,
        data: parseJson(row.data),
        download_url: `/api/employee/documents/${row.id}`,
      })),
    });
  })
);

router.get(
  "/documents/:id",
  employeeOnly,
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, "document id");
    const [document] = await query(
      "SELECT * FROM employee_documents WHERE id = ? AND employee_id = ? LIMIT 1",
      [id, req.user.id]
    );
    if (!document) throw new HttpError(404, "Document not found.");
    res.set("Content-Type", document.content_type);
    res.set("Content-Disposition", `attachment; filename="${safeFilename(document.filename)}"`);
    res.set("Cache-Control", "private, no-store");
    res.send(document.file_data);
  })
);

module.exports = router;
