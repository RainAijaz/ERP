**GIT**
git status
git add .
git commit -m "your message"
git push

## ERP Backend Setup

1. Create database: `erp`
2. Copy `.env.example` to `.env` and fill credentials
3. Run schema:
   - DDL: `npm run db:ddl`
   - OR migrations: `npm run migrate:latest`

## What happens when you move to a real server?

You will do the same two-step process on the server:
Create the database named "erp" on the server (one-time)
Run your migrations/DDL files to create schema/tables inside it

Why this is normal
The database server (your laptop, or a hosted server) is separate from your code.
Your code repo should not “contain the database”, only the instructions to build it (migrations/DDL).

## UTF-8 and Urdu text safety

- This repo is configured for UTF-8 (`.editorconfig` + workspace settings).
- Keep Urdu literals in source files only, and save files in UTF-8 encoding.
- Avoid editing Urdu text through legacy code-page terminals.
- In Windows terminal sessions, run `chcp 65001` before manual text operations.

## Master Data Excel Import (Admin Safe Flow)

### What this feature does

- Route: `/master-data/import`
- Upload Excel workbook (`.xlsx`/`.xls`)
- Select import targets
- Run **Dry-Run** first (validation + create/update preview)
- Apply only when validation passes
- Apply runs in a single transaction (rollback on error)
- Non-admin apply attempts are routed to approval queue instead of direct write

### Supported targets

- Basic Master Data: units, sizes, colors, grades, packing types, cities, product groups/subgroups/types, sales discount policies, party groups, departments, UOM conversions
- Accounts
- Parties
- Products (RM/SFG/FG)

### Production deployment checklist

1. Pull latest code on server
2. Install dependencies in backend:
   - `npm install`
3. Run DB updates:
   - `npm run migrate`
4. Restart backend process (PM2/systemd/service manager)
5. Login as admin and open:
   - `/master-data/import`
6. Run dry-run on real workbook and fix all errors
7. Run apply import

### Security/permission behavior

- Import page is under Master Data module access.
- Direct apply is intended for admins.
- If a non-admin triggers apply, request is queued for approval with import summary metadata.

### Recommended server run command (example)

- PM2 example:
  - `pm2 restart erp-backend || pm2 start src/app.js --name erp-backend`
