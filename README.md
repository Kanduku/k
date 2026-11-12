# KMC Express + MySQL backend

This folder is a standalone JSON API that recreates the Mongo-backed applicant, HR, admin, employee, careers, training, partner, and contact workflows in Express and MySQL. The existing Flask application and its pages are not changed. The current website will continue calling Flask until its forms/frontend are separately pointed at this API.

The app uses Express/Node.js with MySQL (not PHP). MySQL can still be managed through Hostinger's database tools/phpMyAdmin. A PHP-only hosting plan cannot run this Node.js API; select a Hostinger plan that supports a persistent Node.js application and allows it to connect to the MySQL database.

## Setup

1. Create a MySQL database and user in Hostinger. Grant the user access to the database.
2. Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_SSL` in the Hostinger Node.js environment. For local setup, copy `.env.example` to `.env` and set the same values there. Use the database host shown in hPanel; it may differ from your website domain.
3. Create the tables by importing [`schema.sql`](./schema.sql) in phpMyAdmin, or run `npm run db:schema`. Then run `npm run db:check` to verify connectivity and confirm every expected table is present. These database commands do not require `JWT_SECRET`.
4. Set a random `JWT_SECRET` of at least 32 bytes, allowed frontend origins, and a fresh base64-encoded 32-byte `APPLICANT_DATA_ENCRYPTION_KEY`. Never commit secrets.
5. Install and start the API:

   ```sh
   npm install
   npm start
   ```

6. Create the initial admin account once. Set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` temporarily in the process environment, run `npm run db:bootstrap-admin`, then remove those variables. The password must be 12-256 characters. Admin, HR, applicant, and employee passwords are stored as bcrypt hashes.

The API listens on `PORT` (default `3000`) and mounts under `/api`. `/api/health` performs a live MySQL check and reports `database: "connected"` only when the query succeeds. A local connection test can time out if Hostinger disallows external MySQL access; in that case, run the schema/check commands from the Hostinger Node.js environment or enable remote access for the correct source IP. Configure the Hostinger Node.js application root to `KMCbackend`, set the environment variables in its application settings, and use the panel's startup/restart controls. Do not expose `.env` or database credentials through the web root.

## Existing MongoDB data

After applying the MySQL schema, configure `MONGO_URI`, `MONGO_DB_NAME`, and the MySQL values in `.env`, then run:

```sh
npm run db:migrate
```

The one-time import reads the Mongo collections used by the Flask app and the `applicant_documents`, `employee_documents`, and `resumes` GridFS buckets. It preserves each source record in `legacy_records` and also maps it into the operational MySQL tables. The migration is repeatable and does not delete or modify MongoDB data. It reports failed documents and exits unsuccessfully; resolve every reported failure and compare collection/table counts before switching traffic.

If existing applicant government-ID fields/documents are Fernet-encrypted, set the old key as `MONGO_FERNET_KEY` and a new, independent 32-byte key as `APPLICANT_DATA_ENCRYPTION_KEY`. Keep both private. The import decrypts legacy Fernet data in memory and stores it encrypted with AES-256-GCM in MySQL. Do not run the migration without the original Fernet key when encrypted records exist.

Back up both databases before migration. The migration is not an ongoing sync; after cutover, write to MySQL only.

## API reference

See [`API.md`](./API.md) for all public, authentication, applicant, HR, employee, and admin routes, including request headers, JSON fields, multipart uploads, token roles, response shapes, and error handling. Protected endpoints require `Authorization: Bearer <token>`. Password hashes created by the old Flask app (Werkzeug PBKDF2/scrypt) are verified and upgraded to bcrypt after a successful login.

## Security and operations

- Use HTTPS for the API and restrict `CORS_ORIGINS` to the actual website origin(s).
- Keep MySQL and JWT/encryption/SMTP keys in Hostinger's environment settings.
- Rotate the database password that was pasted into chat before connecting this application, and use the replacement only in the environment settings.
- Government-ID values and scans require `APPLICANT_DATA_ENCRYPTION_KEY`. Losing that key makes encrypted values unreadable.
- Employee document uploads are validated PDFs and capped at 8 MB; applicant uploads are validated by file signature and capped at 2 MB.
- The application has no automated live MySQL integration tests. Run `npm test` for local utility tests and validate against a non-production MySQL database before deployment.
