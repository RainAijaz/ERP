**Purpose: version-controlled database structure changes.** 

Each file is a “step” like: create table, add column, add index, create trigger.
You run them in order to build/update the DB the same way on every PC/server.

Commands:
knex migrate:latest → apply new changes
knex migrate:rollback → undo the last batch

Think of it as: Git history for your database schema.

