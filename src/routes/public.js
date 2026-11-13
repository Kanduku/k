const express = require("express");
const { z } = require("zod");
const { query } = require("../db");
const { asyncRoute, HttpError, parsePage, parseJson, serializeJson } = require("../http");
const { randomUUID } = require("node:crypto");
const { programById, programs, durations } = require("../training-catalog");

const router = express.Router();
const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

function decodeOpportunity(row) {
  const data = parseJson(row.data);
  return {
    id: row.id,
    ...data,
    opportunity_type: row.opportunity_type,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    published: Boolean(row.published),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get(
  "/career-opportunities",
  asyncRoute(async (req, res) => {
    const { page, limit, offset } = parsePage(req.query);
    const type = req.query.type;
    if (type && !["job", "internship"].includes(type)) {
      throw new HttpError(400, "Type must be job or internship.");
    }
    const values = type ? [type, limit, offset] : [limit, offset];
    const rows = await query(
      `SELECT * FROM career_opportunities
       WHERE published = TRUE AND opportunity_type IN ('job', 'internship')
       ${type ? "AND opportunity_type = ?" : ""}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      values
    );
    res.json({
      data: rows.map(decodeOpportunity),
      pagination: { page, limit },
    });
  })
);

router.get(
  "/career-opportunities/:id",
  asyncRoute(async (req, res) => {
    const [row] = await query(
      `SELECT * FROM career_opportunities
       WHERE (id = ? OR slug = ?) AND published = TRUE AND opportunity_type IN ('job', 'internship')
       LIMIT 1`,
      [req.params.id, req.params.id]
    );
    if (!row) throw new HttpError(404, "Opportunity not found.");
    res.json({ data: decodeOpportunity(row) });
  })
);

router.get(
  "/partners",
  asyncRoute(async (req, res) => {
    const rows = await query(
      "SELECT * FROM partners WHERE published = TRUE ORDER BY created_at DESC"
    );
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        ...parseJson(row.data),
        name: row.name,
        logo_url: row.logo_url,
        published: Boolean(row.published),
      })),
    });
  })
);

router.get("/training-programs", (req, res) => {
  res.json({ data: programs, durations });
});

router.post(
  "/contacts",
  asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(160),
      email,
      phone: z.string().trim().max(40).optional().default(""),
      message: z.string().trim().min(1).max(10000),
    }).parse(req.body);
    const id = randomUUID();
    await query(
      "INSERT INTO contacts (id, name, email, phone, message, data) VALUES (?, ?, ?, ?, ?, ?)",
      [id, body.name, body.email, body.phone || null, body.message, serializeJson(body)]
    );
    res.status(201).json({ data: { id }, message: "Your message has been received." });
  })
);

router.post(
  "/partner-inquiries",
  asyncRoute(async (req, res) => {
    const body = z.object({
      contact_name: z.string().trim().min(1).max(160),
      email,
      phone: z.string().trim().max(40).optional().default(""),
      organization: z.string().trim().min(1).max(255),
      website: z.string().trim().max(1000).optional().default(""),
      message: z.string().trim().min(1).max(10000),
    }).parse(req.body);
    const id = randomUUID();
    await query(
      `INSERT INTO partner_inquiries
       (id, name, email, phone, organization, message, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.contact_name,
        body.email,
        body.phone || null,
        body.organization || null,
        body.message,
        serializeJson(body),
      ]
    );
    res.status(201).json({ data: { id }, message: "Your partnership inquiry has been received." });
  })
);

router.post(
  "/training-applications",
  asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(160),
      email,
      phone: z.string().trim().regex(/^[0-9+().\-\s]{7,32}$/),
      referral_from: z.string().trim().max(160).optional().default(""),
      background: z.string().trim().max(160).optional().default(""),
      goals: z.string().trim().max(1200).optional().default(""),
      availability: z.enum(["", "Weekday", "Weekend", "Flexible"]).optional().default(""),
      duration: z.enum(["", ...durations]).optional().default(""),
      program_ids: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
      contact_consent: z.literal(true),
    }).passthrough().parse(req.body);
    if (body.phone.replace(/\D/g, "").length < 7) {
      throw new HttpError(400, "Enter a valid phone number.");
    }
    if (new Set(body.program_ids).size !== body.program_ids.length) {
      throw new HttpError(400, "Each training program can only be selected once.");
    }
    if (body.program_ids.some((programId) => !programById.has(programId))) {
      throw new HttpError(400, "Choose valid training programs.");
    }
    const programs = body.program_ids.map((programId) => programById.get(programId));
    const submission = {
      ...body,
      program_titles: programs.map((program) => program.title),
      consent_at: new Date().toISOString(),
    };
    const id = randomUUID();
    await query(
      `INSERT INTO training_applications (id, name, email, phone, referral_from, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, body.name, body.email, body.phone, body.referral_from || null, serializeJson(submission)]
    );
    res.status(201).json({ data: { id }, message: "Your training application has been received." });
  })
);



module.exports = router;
