# KMC Backend API reference

This document describes the Express API in `KMCbackend/src`. It does not describe the separate Flask application at the repository root.

## Base URL and request headers

The default base path is `/api` (configurable with `API_BASE_PATH`). Replace `https://api.example.com` below with the host running this service.

For JSON requests:

```http
Content-Type: application/json
Accept: application/json
```

For protected routes, also send the access token returned by the matching login or applicant signup endpoint:

```http
Authorization: Bearer <access-token>
```

Do not include the word `Bearer` in the token itself. Tokens are JWTs, expire after the configured `JWT_EXPIRES_IN` (default `1h`), and carry one of these roles: `admin`, `hr`, `employee`, or `applicant`. A token for one role cannot be used for another role's routes. There is no token-refresh or logout endpoint; discard the token on the client when signing out.

File-upload requests use `multipart/form-data`. Let the HTTP client set the multipart `Content-Type` and boundary. Do not send JSON `Content-Type` for these requests.

Unless specified otherwise, successful JSON resource responses use a `{ "data": ... }` envelope. List responses may also include `{ "pagination": { "page": n, "limit": n } }`. `204 No Content` responses have no JSON body.

## Authentication

All login and signup requests are public and accept JSON.

| Method and path | Request JSON | Success |
|---|---|---|
| `POST /api/auth/admin/login` | `{"username":"admin@example.com","password":"..."}` | `{ "token", "token_type":"Bearer", "expires_in", "user": { "id", "username", "role":"admin" } }` |
| `POST /api/auth/hr/login` | `{"username":"hr@example.com","password":"..."}` | Token response; user has `id`, `username`, `email`, and the HR account's `role` (for example `reviewer`). |
| `POST /api/auth/employee/login` | `{"email":"employee@example.com","password":"..."}` | Token response; user has `id`, `name`, `email`, and `role:"employee"`. |
| `POST /api/auth/applicant/signup` | `{"name":"...","email":"...","phone":"...","password":"..."}` | `201`; token response with applicant user (`id`, `name`, `email`, `phone`, `role:"applicant"`). Password must be 12–256 characters; phone must match `+`/digits/spaces/parentheses/hyphens and be 7–24 characters. |
| `POST /api/auth/applicant/login` | `{"identity":"email or mobile number","password":"..."}` | Token response with applicant user (`id`, `name`, `email`, `phone`, `role:"applicant"`). |
| `POST /api/auth/employee/forgot-password` | `{"email":"employee@example.com"}` | `{ "message": "If an active account matches that email, reset instructions will be sent." }` |
| `POST /api/auth/employee/reset-password` | `{"token":"<reset-token>","password":"new password of at least 12 characters"}` | `{ "message":"Password updated." }` |

Email fields are validated as email addresses; passwords for login must be non-empty. Signup/reset passwords have a minimum length of 12. Employee password-reset links expire after one hour and can only be used once.

There is no public admin, HR, or employee signup endpoint. An administrator creates HR and employee accounts through the admin routes below; the initial admin account is created through the project's one-time bootstrap script. Applicant signup is the only public account-creation route.

## Public routes

These routes do not need an access token.

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/health` | None | Checks MySQL; returns `{"status":"ok","database":"connected"}`. |
| `GET /api/public/career-opportunities` | Query: `page`, `limit` (defaults 1 and 25; limit max 100), optional `type=job` or `type=internship` | Published job/internship list: `{ "data":[...], "pagination":{...} }`. |
| `GET /api/public/career-opportunities/:idOrSlug` | Path: opportunity UUID/ObjectId or slug | One published job/internship: `{ "data":{...} }`. |
| `GET /api/public/partners` | None | Published partners: `{ "data":[...] }`. |
| `GET /api/public/training-programs` | None | `{ "data":[...], "durations":[...] }` training catalog. |
| `POST /api/public/contacts` | `{"name":"...","email":"...","phone":"...","message":"..."}`; `phone` optional | Saves a contact form; `201` with `{ "data":{"id":"..."},"message":"..." }`. |
| `POST /api/public/partner-inquiries` | `{"contact_name":"...","email":"...","phone":"...","organization":"...","website":"...","message":"..."}`; `phone` and `website` optional | Saves a partnership inquiry; `201` with an id and confirmation message. |
| `POST /api/public/training-applications` | See fields below | Saves a training application; `201` with an id and confirmation message. |

Contact and partnership fields `name`/`contact_name`, `email`, `message`, and `organization` are required as applicable. `email` must be a valid email address. Text limits are 160 characters for a contact name, 254 for email, 40 for phone, 255 for organization, 1,000 for website, and 10,000 for message. Optional phone and website default to empty strings.

Training application JSON:

```json
{
  "name": "Example Applicant",
  "email": "applicant@example.com",
  "phone": "+1 555 123 4567",
  "referral_from": "A colleague",
  "background": "Optional background",
  "goals": "Optional learning goals",
  "availability": "Flexible",
  "duration": "3 months",
  "program_ids": ["python-full-stack-development"],
  "contact_consent": true
}
```

`name`, `email`, `phone`, `program_ids`, and `contact_consent` are required. Phone must contain at least seven digits and match the accepted phone format. `program_ids` must contain 1–50 distinct catalog IDs. `referral_from` is an optional string of up to 160 characters and is also stored in its own nullable database column. `availability` is `""`, `Weekday`, `Weekend`, or `Flexible`; `duration` is `""`, `1 month`, `3 months`, or `6 months`. `background` and `goals` are optional. Additional JSON fields are retained by this endpoint.

## Applicant routes

All `/api/applicant` routes require an applicant token.

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/applicant/me` | None | Current applicant account details. |
| `GET /api/applicant/opportunities` | Query: `page`, `limit` | Published job/internship list with pagination. |
| `GET /api/applicant/applications` | Query: `page`, `limit` | Current applicant's applications and profile-completion percentages. |
| `GET /api/applicant/applications/:applicationId` | Path: application ID | One of the current applicant's applications, including its documents list. |
| `POST /api/applicant/applications/:opportunityId` | `multipart/form-data`; fields below | Creates/updates an application or saves a draft; `201` with application id and status. |
| `GET /api/applicant/applications/:applicationId/documents/:documentType` | Path: application ID and document type | Downloads that applicant's document as a private file response. |

Application multipart fields:

- `profile` — a JSON object encoded as a string, containing profile fields. Scalar values may be strings, numbers, booleans, or null; `education`, `employment`, `certifications`, and `languages` may be arrays of at most 8 records. Supported profile keys use letters, digits, and underscores and must start with a letter.
- `submit` — optional; the exact string `"false"` saves a draft. Any other/missing value attempts final submission.
- `resume` — optional when saving a draft; a final submission needs a resume, either in this request or already on the application. PDF or DOCX.
- `photo` — optional JPG/JPEG/PNG.
- `government_id_scan` — optional PDF/JPG/JPEG/PNG.
- `transcripts` — up to 8 PDF files.

The final-submission profile must include `first_name`, `last_name`, `date_of_birth`, `digital_signature`, `academic_integrity_consent:"yes"`, and `bgv_consent:"yes"`. If `criminal_declaration` or `disciplinary_declaration` is `"yes"`, include the corresponding `criminal_explanation` or `disciplinary_explanation`. When `same_address` is not `"yes"` and any correspondence address field is provided, all of `present_house`, `present_street`, `present_city`, and `present_country` are required. Supplying `government_id_number` requires the API's applicant-data encryption key to be configured. Applicant files are limited by `UPLOAD_MAX_BYTES` (default 2 MiB).

## HR routes

All `/api/hr` routes require an HR token. HR users only see opportunities assigned to their account unless the admin granted `all_opportunities`.

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/hr/dashboard` | Query: `page`, `limit`, optional `status`, optional text `q` | Accessible applications, referrals, and opportunities. |
| `GET /api/hr/applications` | Query: `page`, `limit`, optional `status`, optional text `q` | Accessible applications; excludes drafts unless a status is explicitly supplied. |
| `GET /api/hr/applications/:id` | Path: application ID | Application, document metadata, status history, and internal notes. |
| `PATCH /api/hr/applications/:id` | JSON fields below | Updates HR review fields; returns application id and status. |
| `GET /api/hr/applications/:id/documents/:documentType` | Path: application ID and document type | Downloads an accessible application document. |
| `PATCH /api/hr/referrals/:id/status` | `{"status":"under_hr_review"}` | Updates an accessible referral. Allowed statuses: `under_hr_review`, `shortlisted_for_role`, `interview_scheduled`, `not_selected`. |
| `GET /api/hr/hiring-stages` | None | Active hiring stages usable by HR. |

HR application update JSON accepts any non-empty combination of:

```json
{
  "status": "under_hr_review",
  "recommendation": "no_recommendation",
  "interview_at": "2026-11-12T10:30",
  "internal_note": "Review note"
}
```

`status` must be an active HR-editable stage. `recommendation` is `recommend_offer`, `recommend_reject`, or `no_recommendation`. `interview_at` must use `YYYY-MM-DDTHH:mm` and is interpreted as UTC. `internal_note` is limited to 3,000 characters.

## Employee routes

All `/api/employee` routes require an employee token and operate only on that employee's own records or assigned projects.

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/employee/me` | None | Current employee details. |
| `PATCH /api/employee/me` | Any non-empty subset of `phone`, `alternate_phone`, `address`, `emergency_contact_name`, `emergency_contact_phone` (all strings) | Updates employee-editable profile fields. |
| `GET /api/employee/profile` | None | Employee, assigned projects, leave requests, documents, and promotions. |
| `PATCH /api/employee/password` | `{"current_password":"...","new_password":"..."}` | Changes password; new password must be 12–256 characters. |
| `GET /api/employee/dashboard` | None | Assigned projects, recent leave requests, and referrals. |
| `GET /api/employee/projects` | None | Assigned project list. |
| `GET /api/employee/projects/:id` | Path: assigned project ID | Assigned project and its updates. |
| `POST /api/employee/projects/:id/updates` | JSON described below | Adds a project update; `201` with update id. |
| `GET /api/employee/leave-requests` | None | Current employee's leave requests. |
| `POST /api/employee/leave-requests` | `{"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","reason":"...","leave_type":"annual"}` | Creates a pending request; `201` with id and status. |
| `DELETE /api/employee/leave-requests/:id` | Path: pending leave-request ID | Cancels only the employee's own pending request; `204`. |
| `GET /api/employee/referrals` | None | Current employee's referrals. |
| `POST /api/employee/referrals` | `{"opportunity_id":"...","candidate_name":"...","candidate_email":"...","candidate_phone":"...","candidate_consent":true,"message":"..."}`; `message` optional | Creates a referral for an open role; `201` with id and status. |
| `GET /api/employee/documents` | None | Document metadata and download URLs. |
| `GET /api/employee/documents/:id` | Path: document ID | Downloads the current employee's document. |

Project update JSON accepts `message` (up to 4,000 chars), `task` (1–160 chars), `task_status` (`in_progress`, `blocked`, or `completed`), `progress` (integer 0–100), and `notes` (up to 5,000 chars). At least `message` or `task` must be non-empty. Leave dates must be valid calendar dates and the end date cannot precede the start date. Leave type is `annual`, `sick`, `personal`, or `other`. Referral phone must match the accepted phone format; candidate consent must be `true`; the candidate may only be referred once per opportunity.

## Admin routes

All `/api/admin` routes require an admin token.

### Dashboard, opportunities, applications, and inboxes

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/admin/dashboard` | None | Counts for jobs, internships, applications, contacts, inquiries, partners, projects, employees, and pending leave. |
| `GET /api/admin/opportunities` | Query: `page`, `limit` | All opportunities, published or not. |
| `POST /api/admin/opportunities` | `{"opportunity_type":"job","title":"...","slug":"...","summary":"...","published":false}` | Creates a job, internship, or training opportunity; `201`. Additional fields are stored as opportunity data. |
| `PATCH /api/admin/opportunities/:id` | Any subset of create fields | Updates opportunity fields and additional data. |
| `DELETE /api/admin/opportunities/:id` | Path: opportunity ID | Unpublishes the opportunity (soft delete); `204`. |
| `GET /api/admin/applications` | Query: `page`, `limit` | All applications, including drafts. |
| `GET /api/admin/applications/:id` | Path: application ID | Application, profile, documents, status history, and internal note history. |
| `PATCH /api/admin/applications/:id` | `{"status":"...","internal_notes":"...","applicant_message":"..."}`; any non-empty subset | Updates status, internal notes, or message to applicant. `status` must be an active hiring stage. |
| `GET /api/admin/applications/:id/documents/:documentType` | Path: application ID and document type | Downloads an application document. |
| `GET /api/admin/contacts` | Query: `page`, `limit` | Contact inbox. |
| `PATCH /api/admin/contacts/:id` | `{"status":"new"}` | Status is `new`, `read`, or `archived`. |
| `GET /api/admin/partner-inquiries` | Query: `page`, `limit` | Partnership-inquiry inbox. |
| `PATCH /api/admin/partner-inquiries/:id` | `{"status":"reviewing"}` | Status is `new`, `reviewing`, `accepted`, `rejected`, or `archived`. |
| `GET /api/admin/training-applications` | Query: `page`, `limit` | Training-application inbox. |
| `PATCH /api/admin/training-applications/:id` | `{"status":"contacted"}` | Status is `new`, `reviewing`, `contacted`, or `closed`. |

Opportunity `opportunity_type` is `job`, `internship`, or `training`. `title` is required on creation. `slug`, `summary`, and `published` are optional; additional properties are accepted. For updates, all known fields are optional.

### Partners, HR accounts, employees, and hiring stages

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/admin/partners` | None | All partners. |
| `POST /api/admin/partners` | `{"name":"...","logo_url":"...","published":false}` | Creates partner; `201`. Additional properties are stored as partner data. |
| `PATCH /api/admin/partners/:id` | Any subset of create fields | Updates partner. |
| `DELETE /api/admin/partners/:id` | Path: partner ID | Deletes partner; `204`. |
| `GET /api/admin/hr-accounts` | None | HR accounts plus opportunity scopes; passwords are not returned. |
| `POST /api/admin/hr-accounts` | Required `username`, `email`, `password`; optional `role`, `active`, `all_opportunities`, `opportunity_ids` | Creates HR account; `201`. This object rejects unknown fields. `role` is `reviewer` or `senior_reviewer`; password is 12–256 chars. |
| `PATCH /api/admin/hr-accounts/:id` | Any subset of the HR-account fields above | Updates account and/or opportunity scope. This object rejects unknown fields. |
| `GET /api/admin/hiring-stages` | None | Hiring-stage definitions. |
| `PUT /api/admin/hiring-stages` | `{"stages":[{"key":"under_hr_review","label":"Under HR Review","order":20,"active":true,"hr_editable":true}]}` | Upserts supplied stage definitions; omitted stages are not removed. Array must have 1–100 entries with unique keys. |
| `GET /api/admin/employees` | Query: `page`, `limit` | Employee list. Password hashes are not returned. |
| `GET /api/admin/employees/:id` | Path: employee ID | Employee, projects, documents, promotions, and leave requests. |
| `POST /api/admin/employees` | Required `name`, `email`, `password`; optional `employee_code`, `active`, `employment_status` | Creates employee; `201`. Password is 12–256 chars. Additional employee properties are stored in employee data. |
| `PATCH /api/admin/employees/:id` | Any subset of create fields | Updates employee. Setting `employment_status:"inactive"` deactivates the account. |

HR account `username` and `email` must be valid emails. `opportunity_ids` is an array of opportunity IDs. When `all_opportunities` is true, the account is not restricted to the listed IDs. Changing scopes replaces the existing scope list.

Employee `employment_status` is `active`, `probation`, `on_leave`, `notice_period`, or `inactive`. Employee passwords and HR passwords are never included in API responses.

### Projects, leave, referrals, promotions, employee documents

| Method and path | Query/body | Purpose and success response |
|---|---|---|
| `GET /api/admin/projects` | None | All projects with assigned employee IDs. |
| `GET /api/admin/projects/:id` | Path: project ID | Project, assigned employees, and recent updates. |
| `POST /api/admin/projects` | Required `name`; optional `description`, `status`, `progress`, `start_date`, `due_date`, `assigned_employee_ids` | Creates project; `201`. Dates use `YYYY-MM-DD`; status is `planning`, `in_progress`, `on_hold`, or `completed`; progress is integer 0–100. |
| `PATCH /api/admin/projects/:id` | Any subset of create fields | Updates project and, if supplied, replaces the assignment list. Only active employees can be assigned. |
| `DELETE /api/admin/projects/:id` | Path: project ID | Deletes project; `204`. |
| `GET /api/admin/leave-requests` | Query: `page`, `limit` | Leave requests with employee name/email. |
| `PATCH /api/admin/leave-requests/:id/status` | `{"status":"approved","decision_note":"..."}`; note optional | Approves or rejects request. |
| `GET /api/admin/project-calendar` | Query: optional `year` (2000–2100), `month` (1–12); defaults to current UTC year/month | Project updates for the requested month. |
| `GET /api/admin/employee-referrals` | None | All employee referrals. |
| `PATCH /api/admin/employee-referrals/:id/status` | `{"status":"under_hr_review"}` | Status is `referred`, `under_hr_review`, `shortlisted_for_role`, `interview_scheduled`, `hired`, `not_selected`, or `archived`. |
| `GET /api/admin/employee-promotions` | None | All promotions. |
| `POST /api/admin/employee-promotions` | Required `employee_id`; optional `effective_date`, `status` | Creates promotion; `201`. Date uses `YYYY-MM-DD`; status is `proposed`, `under_review`, `approved`, `rejected`, or `effective`. |
| `PATCH /api/admin/employee-promotions/:id/status` | Required `status`; optional/null `effective_date` | Updates promotion status/date. |
| `POST /api/admin/employees/:employeeId/documents` | `multipart/form-data`: file field `file`, text fields `document_type` and `label` | Uploads a PDF; `201`. Document type is `offer_letter`, `employment_contract`, `promotion_letter`, `identity_document`, `certificate`, or `other`. |
| `GET /api/admin/employees/:employeeId/documents` | Path: employee ID | Lists employee document metadata. |
| `GET /api/admin/employees/:employeeId/documents/:documentId` | Path: employee and document IDs | Downloads PDF document. |
| `DELETE /api/admin/employees/:employeeId/documents/:documentId` | Path: employee and document IDs | Deletes document; `204`. |

Project request objects accept additional properties, which are kept in project data. Employee document uploads are limited to one PDF file and 8 MiB.

## Pagination, IDs, errors, and limits

- List routes accepting pagination use `?page=1&limit=25` by default. Page is clamped to at least 1; limit is clamped to 1–100.
- IDs accepted by ID-validated routes are UUIDs or 24-character hexadecimal MongoDB ObjectIds.
- Errors use `{ "error": { "code": "...", "message": "..." } }`. Validation errors use code `VALIDATION_ERROR` and may include `details: [{"path":"...","message":"..."}]`.
- Common HTTP errors include `400` invalid input, `401` missing/invalid/expired token, `403` wrong role or rejected CORS origin, `404` missing/inaccessible resource, `409` duplicate record, `413` file too large, `429` rate limit, and `500` unexpected server error.
- Authentication routes are limited to 20 requests per 15 minutes; public routes are limited to 60 requests per 15 minutes. Rate-limit responses use code `RATE_LIMITED`.
- Unmatched API paths return `404` with code `NOT_FOUND`.

There are no partner login/signup routes, no applicant mobile-verification routes, and no server-side logout route in this backend. Partners can be listed publicly and partnership inquiries can be submitted without an account.
