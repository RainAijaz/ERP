const TABLE = "notification";

exports.up = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (hasTable) return;

  await knex.schema.withSchema("erp").createTable(TABLE, (table) => {
    table.bigIncrements("id").primary();
    // Recipient of the notification (fan-out: one row per recipient).
    table
      .bigInteger("user_id")
      .notNullable()
      .references("id")
      .inTable("erp.users")
      .onDelete("CASCADE");
    // Notification category, e.g. 'APPROVAL_PENDING'.
    table.text("type").notNullable();
    // Optional link back to the source approval request.
    table
      .bigInteger("approval_request_id")
      .nullable()
      .references("id")
      .inTable("erp.approval_request")
      .onDelete("CASCADE");
    table
      .bigInteger("branch_id")
      .nullable()
      .references("id")
      .inTable("erp.branches")
      .onDelete("SET NULL");
    table.text("title").nullable();
    table.text("body").nullable();
    // Deep-link URL the client navigates to when the notification is opened.
    table.text("link").nullable();
    table.boolean("is_read").notNullable().defaultTo(false);
    table.timestamp("read_at").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    // Drives the unread-count and recent-list queries (per recipient).
    table.index(
      ["user_id", "is_read", "created_at"],
      "idx_notification_user_unread_created",
    );
  });
};

exports.down = async (knex) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(TABLE);
  if (!hasTable) return;
  await knex.schema.withSchema("erp").dropTable(TABLE);
};
