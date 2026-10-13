# LMS Backend (Alimentaria Mexicana)

Backend API for the Alimentaria Mexicana Learning Management System (LMS). It is used by restaurant staff to read bilingual (English and Spanish) work procedures such as recipes, cleaning steps, and food safety checks, and by a super admin to manage employees and the content library.

The frontend is a separate app (Next.js style routes like `/{lang}/employee/home`). This repo is the REST API only.

---

## Table of contents

1. [What the system does](#what-the-system-does)
2. [Tech stack](#tech-stack)
3. [Getting started](#getting-started)
4. [Environment variables](#environment-variables)
5. [Scripts](#scripts)
6. [Project structure](#project-structure)
7. [Request lifecycle](#request-lifecycle)
8. [Authentication and roles](#authentication-and-roles)
9. [Data model](#data-model)
10. [API reference](#api-reference)
11. [Procedure content format](#procedure-content-format)
12. [Responses and errors](#responses-and-errors)
13. [File uploads](#file-uploads)
14. [Database migrations and seeding](#database-migrations-and-seeding)
15. [Code conventions](#code-conventions)
16. [Known issues and cleanup list](#known-issues-and-cleanup-list)

---

## What the system does

- **Employee onboarding by invite.** A super admin creates an employee. The system emails a magic link (via Resend). The employee clicks it, lands on a "set password" page, chooses a password, and the account becomes `active`.
- **Login and sessions.** Email and password login backed by Better Auth. Sessions work with both an HttpOnly cookie and a Bearer token.
- **Password reset by OTP.** A 6 digit code is emailed and expires after 10 minutes.
- **Organisation setup.** Locations (restaurants), stations (for example "Grill station"), and jobs (for example "Line Cook", each linked to a set of stations).
- **Content library.** Categories and subcategories group content. Procedures are rich, block based documents stored in both English and Spanish. Each procedure can be linked to a subcategory, a station, a quiz, and a list of assigned employees, and moves through `draft`, `published`, and `archived`.
- **Quizzes.** Simple multiple choice quizzes that can be attached to procedures.
- **Media uploads.** Images, videos, and documents are uploaded to Cloudflare R2 (S3 compatible storage) and served from a public URL.

---

## Tech stack

| Concern         | Choice                                                             |
| --------------- | ------------------------------------------------------------------ |
| Runtime         | Node.js 20 or newer, ESM (`"type": "module"`)                      |
| Language        | TypeScript 6 (strict mode, `.ts` import extensions)                |
| Web framework   | Express 5                                                          |
| Database        | PostgreSQL via `postgres` (postgres.js driver)                     |
| ORM             | Drizzle ORM, migrations with drizzle-kit                           |
| Auth            | Better Auth (email and password, magic link, email OTP, bearer)    |
| Validation      | Zod v4                                                             |
| Email           | Resend                                                             |
| File storage    | Cloudflare R2 through `@aws-sdk/client-s3`                         |
| Logging         | pino with pino-pretty, plus a one line request logger in `app.ts`  |
| Security        | helmet, cors, express-rate-limit                                   |
| Error reporting | `@sentry/node` (called, but not yet initialised, see known issues) |
| Dev tooling     | pnpm, tsx, nodemon, ESLint, Prettier, Husky, lint-staged           |

---

## Getting started

### Prerequisites

- Node.js 20 or newer
- pnpm
- A PostgreSQL database (local or managed, for example Neon)

### Steps

```bash
# 1. Install dependencies
pnpm install

# 2. Create development.env in the project root (see the next section)

# 3. Apply database migrations
pnpm db:migrate

# 4. Seed base data (locations, jobs, stations, categories, super admin)
pnpm db:seed

# 5. Start the dev server with auto reload
pnpm dev
```

The server starts on `http://localhost:8000` by default. Check it with:

- `GET /` or `GET /health` - app is running
- `GET /health/db` - database is reachable

On startup the server also runs `select 1` against the database and exits if that fails.

---

## Environment variables

Config is loaded from **`development.env`** (hard coded in [src/config/env.ts](src/config/env.ts)) and validated with Zod at boot. If a required variable is missing, the app refuses to start and names the missing variable. The `.env` file in the root is **not** read by the app.

| Variable                | Required | Default                 | Purpose                                                                  |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`              | no       | `development`           | `development`, `production`, or `test`                                   |
| `PORT`                  | no       | `8000`                  | HTTP port                                                                |
| `DATABASE_URL`          | yes      | -                       | PostgreSQL connection string                                             |
| `BETTER_AUTH_SECRET`    | yes      | -                       | Signing secret, 32 or more random characters                             |
| `BETTER_AUTH_URL`       | no       | `http://localhost:8000` | Public base URL of this API, used for magic link redirects               |
| `FRONTEND_BASE_URL`     | no       | `http://localhost:3000` | Frontend origin. Used for CORS, trusted origins, email links             |
| `RESEND_API_KEY`        | no       | -                       | Needed to actually send invite and OTP emails                            |
| `R2_ACCOUNT_ID`         | no       | -                       | Cloudflare account id                                                    |
| `R2_ENDPOINT`           | no       | -                       | Optional. Defaults to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID`      | no       | -                       | R2 access key                                                            |
| `R2_SECRET_ACCESS_KEY`  | no       | -                       | R2 secret key                                                            |
| `R2_BUCKET`             | no       | -                       | Bucket name                                                              |
| `R2_PUBLIC_BASE_URL`    | no       | -                       | Public URL prefix for uploaded files                                     |
| `R2_UPLOAD_TTL_SECONDS` | no       | `600`                   | Reserved for presigned uploads                                           |
| `R2_UPLOAD_MAX_BYTES`   | no       | `10485760` (10 MB)      | Max size for a direct upload                                             |
| `GOOGLE_AI_API_KEY`     | no       | -                       | Reserved for AI extraction (not used by any route yet)                   |
| `GEMINI_MODEL`          | no       | `gemini-3.6-flash`      | Reserved for AI extraction                                               |

Never commit `development.env` or `.env`. Both are listed in `.gitignore`.

---

## Scripts

| Command                      | What it does                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`                   | Runs `src/index.ts` with tsx under nodemon, restarts on change                         |
| `pnpm build`                 | Compiles to `dist/` with `tsc`, then copies yaml assets                                |
| `pnpm start`                 | Runs the compiled build from `dist/index.js`                                           |
| `pnpm typecheck`             | Type checks without emitting                                                           |
| `pnpm lint`                  | Runs ESLint (`lint:fix` to auto fix)                                                   |
| `pnpm format`                | Formats the code with Prettier                                                         |
| `pnpm db:generate`           | Generates a new SQL migration from the Drizzle schema                                  |
| `pnpm db:migrate`            | Applies pending migrations                                                             |
| `pnpm db:studio`             | Opens Drizzle Studio to browse the database                                            |
| `pnpm db:seed`               | Runs the full seed (see below)                                                         |
| `pnpm admin:promote <email>` | Gives an existing user super admin access (`--revoke` to remove)                       |
| `pnpm test:e2e [suite...]`   | Runs the end-to-end API tests (needs `DATABASE_URL` of a migrated and seeded database) |

A Husky pre commit hook runs `lint-staged`, which runs `eslint --fix` and `prettier --write` on staged `.ts` and `.mjs` files.

---

## Project structure

Code is grouped by feature: everything for one feature (routes, controller, service, validation) lives in one folder under `src/modules/`. The full rules for where code goes and how files are named are in [Agent.md](Agent.md).

```
.
|-- src/
|   |-- index.ts              Starts the HTTP server, DB check, graceful shutdown
|   |-- app.ts                Express app: middleware order, routes, error chain
|   |-- routes.ts             The /api/v1 router: mounts every module's routes
|   |-- config/
|   |   |-- env.ts            Loads development.env and validates it with Zod (the only file that reads process.env)
|   |   `-- logger.ts         pino logger
|   |-- db/
|   |   |-- client.ts         postgres.js pool + Drizzle instance (db, sql, closeDb)
|   |   `-- schema/           One <name>.schema.ts per table group; index.ts re-exports them (read by drizzle-kit)
|   |-- lib/                  Integrations with outside services
|   |   |-- auth.ts           Better Auth instance (plugins, sessions, cookies, invite and OTP emails)
|   |   |-- storage.ts        Cloudflare R2 (S3) client: putObject, publicUrlFor
|   |   `-- email/            Resend client and HTML email templates
|   |-- middleware/           require-auth, require-roles, validate, rate-limit, request-id, not-found, error-handler
|   |-- shared/               api-error, api-response, catch-async, pagination, common.validation (uuid checks)
|   |-- modules/
|   |   |-- auth/             auth.routes.ts, auth.controller.ts, auth.service.ts, auth.validation.ts
|   |   |-- employees/        same files plus employees.mapper.ts (the employee response shapes)
|   |   |-- categories/       categories.* and subcategories.* (subcategories belong to this module)
|   |   |-- locations/  stations/  jobs/  quizzes/  uploads/
|   |   `-- procedures/       procedures.validation.ts holds the block body schemas
|   `-- types/                Express request augmentation and module declarations
|-- tests/e2e/                End-to-end API tests (pnpm test:e2e)
|-- docs/                     CHANGES.md (what was fixed) and DESIGN-DECISIONS.md (open decisions)
|-- drizzle/migrations/       Generated SQL migrations and snapshots
|-- scripts/                  Seed scripts, admin:promote, small utilities
|-- drizzle.config.ts         drizzle-kit config
|-- Agent.md                  Rules for structure, naming and coding (for AI agents and developers)
`-- LMS-Backend.postman_collection.json   Postman collection for manual testing
```

---

## Request lifecycle

Every request passes through `app.ts` in this order:

1. `requestId` - reads `X-Request-Id` or creates a UUID and echoes it back in the response header
2. Request logger - prints one line per request, for example `2026-10-07 13:21:30 INFO  GET /api/v1/locations -> 200 (1401ms)`
3. `cors` - only `FRONTEND_BASE_URL` is allowed, with credentials
4. `helmet` and `trust proxy`
5. **Better Auth handler** at `/api/auth/*` - mounted **before** `express.json()` because Better Auth reads the raw body itself
6. `express.json()`
7. `/`, `/health`, `/health/db`
8. `/api/v1/*` feature routers
9. 404 handler, then `errorConverter`, then `errorHandler`

Inside a feature the code is layered, and dependencies only flow downwards:

```
route       path + HTTP verb + requireAuth + requireRoles + rate limit + validate
  |
controller  read req, call the service, send ApiResponse.success(...)
  |
service     business rules, Drizzle queries, throw ApiError on failure
  |
db schema   table definitions only
```

---

## Authentication and roles

### Two auth surfaces

- **`/api/auth/*`** - Better Auth's own built in endpoints (for example `/api/auth/magic-link/verify`, `/api/auth/sign-in/email`). The frontend can call these directly.
- **`/api/v1/auth/*`** - this project's own endpoints that wrap Better Auth and add LMS rules (employee status, set password, OTP reset).

### Better Auth setup ([src/lib/auth.ts](src/lib/auth.ts))

- Plugins: `bearer` (token in `Authorization` header), `magicLink` (invites, valid 24 hours), `emailOTP` (password reset, 6 digits, 10 minutes)
- Sessions last 8 hours and slide forward every 15 minutes of activity. No cookie cache, so every request hits the database for a consistent answer.
- In production cookies use the `__Host-` prefix and are `Secure`. Always `HttpOnly` and `SameSite=Lax`.
- Email verification is turned off. Users are marked verified by the backend when they activate.

### Employee invite flow

1. Super admin calls `POST /api/v1/employees`. An `employees` row is created with status `pending`.
2. Backend calls Better Auth `signInMagicLink`. The `sendMagicLink` hook builds a friendly link `FRONTEND_BASE_URL/{lang}/invite/token?token=...` and emails it through Resend. The same link is returned in the API response as `inviteUrl` so the admin can share it by hand.
3. The frontend sends the user to `GET /api/v1/auth/invites/:lang/:token`, which redirects to Better Auth's `/api/auth/magic-link/verify`. Better Auth sets the session cookie and redirects to the frontend `/{lang}/set-password`.
4. The frontend calls `POST /api/v1/auth/set-password`. The backend links the Better Auth user to the employee (by email), stores the password hash (scrypt, via Better Auth) in the `account` table, and sets the employee to `active`.
5. From then on the employee logs in with `POST /api/v1/auth/login`, which returns a token and also sets the cookie.

### Password reset flow

1. `POST /api/v1/auth/password/forget` with `{ email }` - always returns 200 so attackers cannot discover which emails exist.
2. `POST /api/v1/auth/password/reset` with `{ email, otp, password }`.

### Roles and guards

Roles are `super_admin`, `manager`, `employee` (defined in [src/db/schema/employees.schema.ts](src/db/schema/employees.schema.ts)).

- **`requireAuth`** ([src/middleware/require-auth.ts](src/middleware/require-auth.ts)) - validates the session (cookie or Bearer token), loads the linked employee, and rejects inactive employees with `401`. A user with **no employee row** is a **super admin** only when `user.role = 'super_admin'` (`req.isSuperAdmin = true`, `req.employee.id = ''`). Any other user without an employee row, for example a self sign-up, gets `403`.
- **Making someone a super admin:** `pnpm admin:promote <email>` (or `--revoke`). The role cannot be set through sign-up. The seed does this for the dev admin automatically.
- **`requireRoles([...])`** ([src/middleware/require-roles.ts](src/middleware/require-roles.ts)) - checks the role, active status, and fills `req.employee`.
- Optional header `X-Device-Mode: shared` marks a kiosk or shared device. It is exposed as `deviceMode` on the request and in `/me`.

Currently every write route requires `super_admin`. `manager` exists as a role but no route grants it extra rights yet.

---

## Data model

All LMS tables use UUID primary keys. Better Auth tables use text ids because Better Auth generates nanoid style ids.

| Table           | Purpose                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`          | Better Auth user (name, email, emailVerified)                                                                                                                                                                             |
| `session`       | Better Auth sessions, deleted when an employee is deactivated                                                                                                                                                             |
| `account`       | Better Auth credentials (scrypt password hash, provider `credential`)                                                                                                                                                     |
| `verification`  | Better Auth tokens for magic links and OTPs                                                                                                                                                                               |
| `employees`     | LMS employee. Links to `user` via `user_id`. Has `location_id`, `role`, `job_ids[]`, `station_ids[]`, `language_pref` (`en` or `es`), `status` (`pending`, `active`, `deactivated`), optional 6 character `employee_code` |
| `locations`     | Restaurants or sites                                                                                                                                                                                                      |
| `stations`      | Work stations                                                                                                                                                                                                             |
| `jobs`          | Job titles, each with a `station_ids[]` array                                                                                                                                                                             |
| `categories`    | Top level grouping, bilingual name, `category_type` (for example `general`, `station_based`), icon                                                                                                                        |
| `subcategories` | Belong to a category (cascade delete)                                                                                                                                                                                     |
| `procedures`    | Bilingual title and purpose, `slug` (unique), `status`, `previous_status`, `blocks_en` and `blocks_es` (JSON), links to subcategory, station, quiz, and `assign_users[]`                                                  |
| `quiz`          | Bilingual name, `quiz_type` (`procedure` or `course`), `questions` as JSON                                                                                                                                                |

Relationships in short:

```
location 1---* employee *---1 user (Better Auth)
job      *---* station        (via jobs.station_ids array)
employee *---* job, station   (via arrays on employees)
category 1---* subcategory 1---* procedure *---1 station
                                  procedure *---1 quiz
```

Delete rules worth knowing:

- A location cannot be deleted while employees use it (`409 LOCATION_IN_USE`).
- A job cannot be deleted while employees reference it (`409 ROLE_IN_USE`).
- Deleting a subcategory, station, or quiz sets the procedure's link to `null` instead of deleting the procedure.

---

## API reference

Base path: `/api/v1`. Auth means a valid session cookie or `Authorization: Bearer <token>`. List endpoints accept `?page=1&limit=10&search=text` and return a `meta` object with `page`, `limit`, `total`, `totalPages`.

### Auth - `/api/v1/auth`

| Method | Path                    | Access             | Notes                                                                        |
| ------ | ----------------------- | ------------------ | ---------------------------------------------------------------------------- |
| GET    | `/me`                   | session            | Returns the employee profile, or `{ user, role: 'super_admin' }`             |
| POST   | `/login`                | public             | `{ email, password }`. Returns `{ token, user }`. 10 failed tries per 15 min |
| POST   | `/set-password`         | magic link session | `{ password }`. Activates the employee. 5 tries per 15 min                   |
| POST   | `/sign-up`              | public             | `{ name, email, password }`. Creates a plain Better Auth user                |
| GET    | `/invites/:lang/:token` | public             | Redirects to Better Auth magic link verification                             |
| POST   | `/password/forget`      | public             | `{ email }`. Sends a reset OTP. 5 per 15 min                                 |
| POST   | `/password/reset`       | public             | `{ email, otp, password }`. 5 per 15 min                                     |

New passwords need 8 or more characters with a lowercase letter, an uppercase letter, a number, and a special character. Auth request bodies are strict, so unknown fields are rejected.

### Employees - `/api/v1/employees` (super_admin)

| Method | Path              | Notes                                                         |
| ------ | ----------------- | ------------------------------------------------------------- |
| GET    | `/`               | List. Filter with `?status=pending\|active\|deactivated\|all` |
| GET    | `/:id`            | One employee                                                  |
| POST   | `/`               | Create and send invite. Returns `{ employee, inviteUrl }`     |
| PUT    | `/:id`            | Full update                                                   |
| POST   | `/:id/invites`    | Resend invite (pending employees only)                        |
| POST   | `/:id/deactivate` | Sets `deactivated` and deletes all their sessions             |
| POST   | `/:id/reactivate` | Sets back to `active`                                         |

### Locations, stations - `/api/v1/locations`, `/api/v1/stations` (super_admin)

`GET /`, `POST /` with `{ name }`, `PATCH /:id`, `DELETE /:id`.

### Jobs - `/api/v1/jobs`

| Method | Path        | Access      | Notes                                                                                                            |
| ------ | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| QUERY  | `/stations` | session     | Uses the new HTTP `QUERY` method. Pass `jobIds` as `?jobIds=a,b` or in the body. Returns stations for those jobs |
| GET    | `/`         | super_admin | List jobs                                                                                                        |
| POST   | `/`         | super_admin | `{ name, stationIds? }`                                                                                          |
| PATCH  | `/:id`      | super_admin | `{ name?, stationIds? }`                                                                                         |
| DELETE | `/:id`      | super_admin | Refused if employees use the job                                                                                 |

### Categories and subcategories - `/api/v1/categories`, `/api/v1/subcategories`

| Method | Path                             | Access      | Notes                                                                                                                |
| ------ | -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                              | session     | List categories (accepts `?status=active\|archived\|all&search=&page=&limit=`). Response includes `proceduresCount`. |
| GET    | `/:id`                           | session     | Get single category by ID. Response includes `proceduresCount`.                                                      |
| POST   | `/`                              | super_admin | Create category                                                                                                      |
| PATCH  | `/:id`                           | super_admin | Update category                                                                                                      |
| DELETE | `/:id`                           | super_admin | Delete category                                                                                                      |
| POST   | `/:id/archive`                   | super_admin | Archive category (`status` -> `archived`)                                                                            |
| POST   | `/:id/unarchive`                 | super_admin | Unarchive category (`status` -> `active`)                                                                            |
| GET    | `/subcategories`                 | session     | List subcategories (accepts `?categoryId=&search=&page=&limit=`)                                                     |
| GET    | `/:categoryId/subcategories`     | session     | List subcategories for a category                                                                                    |
| POST   | `/:categoryId/subcategories`     | super_admin | Create subcategory                                                                                                   |
| PATCH  | `/:categoryId/subcategories/:id` | super_admin | Update subcategory                                                                                                   |
| DELETE | `/:categoryId/subcategories/:id` | super_admin | Delete subcategory                                                                                                   |

### Procedures - `/api/v1/procedures`

| Method | Path             | Access      | Notes                                                                                         |
| ------ | ---------------- | ----------- | --------------------------------------------------------------------------------------------- |
| GET    | `/`              | super_admin | List, newest updated first                                                                    |
| GET    | `/filter`        | super_admin | `?status=&stationIds=&subcategoryIds=&categoryIds=&search=` (lists are comma separated UUIDs) |
| GET    | `/:slug`         | session     | Read one procedure by slug                                                                    |
| POST   | `/`              | super_admin | Create. Slug is generated from `titleEn` and made unique (`-2`, `-3`, ...)                    |
| PUT    | `/:id`           | super_admin | Full update, same validation as create                                                        |
| DELETE | `/:id`           | super_admin | Permanently delete a procedure                                                                |
| POST   | `/:id/archive`   | super_admin | Saves the current status in `previousStatus`, then sets `archived`                            |
| POST   | `/:id/unarchive` | super_admin | Restores `previousStatus` (or `draft`)                                                        |

### Quizzes - `/api/v1/quizzes`

`GET /` (session), `GET /:id` (session), `POST /` (super_admin) with `{ nameEn, nameEs, quizType?, questions[] }`.

### Uploads - `/api/v1/uploads` (super_admin)

`POST /` as `multipart/form-data` with a field named `file`. Returns `{ key, publicUrl }`.

A ready to import Postman collection is in [LMS-Backend.postman_collection.json](LMS-Backend.postman_collection.json).

---

## Procedure content format

A procedure body is `{ blocks: Block[] }`, sent twice as `bodyEn` and `bodyEs`. Schemas live in [src/modules/procedures/procedures.validation.ts](src/modules/procedures/procedures.validation.ts). Each block has an `id` and a `kind`:

| Kind          | What it holds                                                      |
| ------------- | ------------------------------------------------------------------ |
| `text`        | Paragraph                                                          |
| `heading`     | Level 1 to 3 heading                                               |
| `method`      | Ordered steps (at least one)                                       |
| `recipe`      | Steps plus ingredients, yields, scaling factors, allergen info     |
| `ingredients` | Ingredients, yields, factors, allergen info without steps          |
| `image`       | Image with alt text, caption, and `photo` or `diagram` hint        |
| `video`       | Video URL and caption                                              |
| `warning`     | Callout with severity `warn`, `tip`, `alt`, `equip`, or `allergen` |
| `attachment`  | Link to a file                                                     |
| `table`       | Headers and rows, each cell in both languages                      |
| `checklist`   | Title and checklist items                                          |

A step can have a phase, a body, a timer, images, a note, a video segment (`startSec` to `endSec`), and can be marked `critical` with a `criticalLimit` (value, how to check, what to do on breach).

Extra rules checked by the service:

- In `recipe` and `ingredients` blocks, `ingredients` and `factors` must be set together, and every ingredient must have exactly one amount per factor.
- Every step marked `critical` must have a `criticalLimit`.
- The linked subcategory and station must exist.
- Assigned users must exist and have the `employee` role.

When reading, a stored body that no longer matches the schema is logged and returned as an empty block list, so one bad row does not break a whole list.

---

## Responses and errors

Success:

```json
{ "success": true, "message": "Employees retrieved successfully", "data": {} }
```

Error (from the shared error handler):

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Invalid input",
  "errors": [{ "field": "email", "message": "Invalid email" }]
}
```

How errors are normalised in [error-handler.ts](src/middleware/error-handler.ts):

- Zod error - `400 VALIDATION_ERROR` with field details
- Body too large - `413 PAYLOAD_TOO_LARGE`
- Bad JSON - `400 INVALID_JSON`
- Postgres invalid input (`22P02`, for example a non UUID id) - `400 INVALID_INPUT`
- Postgres foreign key or unique violation (`23503`, `23505`) - `409 CONFLICT`
- Any other Postgres error - `500 DATABASE_ERROR` (the SQL is logged, never sent to the client)
- Multer error - `400 VALIDATION_ERROR`
- Rate limit - `429 TOO_MANY_REQUESTS`
- In production, non operational errors are masked as a plain `500`

Note: some middleware and controllers (404 handler, `requireAuth`, `requireRoles`, a few 409 checks) still reply with an older shape `{ "error": { "code", "message" } }`. Frontend code should handle both for now.

---

## File uploads

- Upload route uses multer with in memory storage, size limited by `R2_UPLOAD_MAX_BYTES`.
- The folder is chosen by mime type: `uploads/images/`, `uploads/videos/`, or `uploads/documents/`, with a random 16 character hex file name and the original extension.
- The file is written to R2 with [src/lib/storage.ts](src/lib/storage.ts), the single storage client. Its endpoint is `R2_ENDPOINT` if set, otherwise it is built from `R2_ACCOUNT_ID`. Only letters and digits are kept in the file extension.
- If storage is not configured the API answers `503 STORAGE_NOT_CONFIGURED`; if R2 fails or is unreachable it answers `502 STORAGE_UNAVAILABLE` (details are logged).
- The response `publicUrl` is `R2_PUBLIC_BASE_URL/<key>`.

---

## Database migrations and seeding

The migration history was squashed into a single `0000_baseline.sql` during development (there was no production database yet). A database created from the old migrations must be dropped and recreated with `pnpm db:migrate` and `pnpm db:seed`.

### Changing the schema

1. Edit or add a file in `src/db/schema/` and make sure it is re-exported from [src/db/schema/index.ts](src/db/schema/index.ts). drizzle-kit only sees tables exported from that barrel.
2. `pnpm db:generate` and review the new SQL in `drizzle/migrations/`.
3. `pnpm db:migrate`.

### Seeding (`pnpm db:seed`)

[scripts/seed.ts](scripts/seed.ts) runs, in order:

1. `seed-locations.ts` - Mexicana Main, Downtown Express, Almentria Mexicana
2. `seed-jobs.ts` - Line Cook, Prep Cook, Dishwasher (removes jobs not in this list)
3. `seed-stations.ts` - stations and links them to jobs
4. Creates a master `super_admin` employee row (fixed id `00000000-0000-0000-0000-000000000000`)
5. Creates a Better Auth super admin user with no employee row. The dev login email and password are printed by the script and defined in `ensureSuperAdminUser` in `scripts/seed.ts`. Change them before using any shared environment.
6. `seed-categories.ts` - **deletes all categories and subcategories**, then inserts the defaults (Onboarding, Food Safety, Cleaning, Kitchen Operations, Opening and Closing, Equipment, Recipes)

The categories are owned by the super admin user created in step 6, so that user is created before the categories are seeded. When `seed-categories.ts` is run on its own it uses `SEED_CREATOR_USER_ID`, or the oldest user in the database.

Other scripts: `promote-super-admin.ts` (`pnpm admin:promote`), `upload-zigzag.ts` uploads a decorative SVG to R2, `upload-email-assets.ts` uploads the PNG zigzag used under the email header (run it once per bucket), `copy-assets.mjs` copies yaml files into `dist/` during build.

---

## Code conventions

All rules (folder layout, file naming, layering, validation, errors, database, testing) are in [Agent.md](Agent.md). The short version:

- Import local files with the `.ts` extension and use `import type` for type only imports.
- Routes only wire middleware and handlers, controllers only handle HTTP, services hold the business rules and all database access.
- Never change an existing request or response format. Run `pnpm typecheck`, `pnpm lint` and `pnpm test:e2e` after every change.

Adding a new feature means: tables in `src/db/schema/` (exported from its `index.ts`), `pnpm db:generate`, then a folder `src/modules/<feature>/` with routes, controller, service and validation files, mounted in [src/routes.ts](src/routes.ts), plus a suite in `tests/e2e/`.

---

## Known issues and cleanup list

Things found while reviewing the code. They are worth fixing before production. Each open item, with options and how to build them, is in [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md); what has already been fixed is in [docs/CHANGES.md](docs/CHANGES.md).

**Configuration**

- `development.env` and `.env` contain `FRONTEND_BASE_URl` (lowercase `l` at the end). It only works on Windows, where environment variable names are case insensitive. On Linux (most servers and Docker) the real `FRONTEND_BASE_URL` is never set and falls back to `http://localhost:3000`, which breaks CORS, trusted origins, and every email link.
- The root `.env` file is not loaded by the app. Variables like `SESSION_SECRET`, `COOKIE_NAME`, `ADMIN_BOOTSTRAP_TOKEN`, `PUBLIC_WEB_BASE_URL` are not used anywhere.
- Real secrets live in plain env files on disk. Rotate them if these files were ever shared, and keep them out of version control.

**Auth and permissions**

- `POST /api/v1/auth/sign-up` (and Better Auth's own `/api/auth/sign-up/email`) is public and creates verified users. Those users have no access to anything, but decide whether sign-up should exist in production at all.
- The email sender name is spelled "Almentria" in emails and seeds, while the product name is "Alimentaria".
- The `manager` role is defined but has no permissions.
- `GET /api/v1/procedures/:slug` returns drafts and archived procedures to any logged-in employee, not only published ones. Decide whether employees should only see published (or assigned) procedures.
- `GET /api/v1/quizzes/:id` sends `correctChoiceId` to employees, so the answers are visible before taking a quiz. Fixing it needs a different response for employees and a grading endpoint.

**Code health**

- `@sentry/node` is used in the error handler but `Sentry.init` is never called, so nothing is reported.
- Unused dependencies: `@google/genai`, `pdf-parse`, `mammoth`, `commander`, `jose`, `cookie`, `pino-http`.
- Many routes validate inside the controller with `safeParse` rather than the `validate()` middleware, and response error shapes are mixed (see Responses and errors).
