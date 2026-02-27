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
