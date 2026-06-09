const { sendWhatsAppMessage } = require("./whatsapp");

const formatRate = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return `Rs. ${numericValue.toLocaleString("en-PK")}`;
};

const sendSkuRateNotification = async ({
  knex,
  chatId,
  updates = [],
  user,
  approved = false,
}) => {
  if (!chatId || !String(chatId).trim()) return;

  const normalizedUpdates = Array.isArray(updates)
    ? updates
        .map((update) => ({
          id: Number(update?.id),
          newRate: update?.newRate ?? update?.rate ?? update?.sale_rate ?? null,
          oldRate: update?.oldRate ?? update?.old_rate ?? null,
        }))
        .filter((update) => Number.isInteger(update.id) && update.id > 0)
    : [];

  if (!normalizedUpdates.length) return;

  try {
    const details = await knex("erp.variants as v")
      .select("v.id", "i.name as item_name", "k.sku_code")
      .leftJoin("erp.items as i", "v.item_id", "i.id")
      .leftJoin("erp.skus as k", "k.variant_id", "v.id")
      .whereIn(
        "v.id",
        normalizedUpdates.map((update) => update.id),
      );

    const detailMap = new Map(details.map((row) => [Number(row.id), row]));
    const username = user?.username || user?.name || "Unknown";
    const timeStr = new Date().toLocaleString("en-PK", {
      timeZone: "Asia/Karachi",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const lines = normalizedUpdates.map((update) => {
      const detail = detailMap.get(update.id);
      const sku = detail?.sku_code || `#${update.id}`;
      const name = detail?.item_name || "-";
      const newRateStr = formatRate(update.newRate);
      const oldRateStr = formatRate(update.oldRate);
      let change = "";

      if (oldRateStr && newRateStr) {
        const oldNumeric = Number(update.oldRate);
        const newNumeric = Number(update.newRate);
        if (Number.isFinite(oldNumeric) && Number.isFinite(newNumeric)) {
          if (newNumeric > oldNumeric) change = `  ↑ (was ${oldRateStr})`;
          else if (newNumeric < oldNumeric) change = `  ↓ (was ${oldRateStr})`;
        }
      }

      return `• ${sku}  —  ${name}  →  ${newRateStr || "-"}${change}`;
    });

    const message = `*Rate Update Alert*\nBy: ${username}${approved ? " (approved)" : ""}\nTime: ${timeStr}\n\n${lines.join("\n")}`;
    await sendWhatsAppMessage(chatId, message);
  } catch (err) {
    console.error("[WhatsApp] SKU rate notify error:", err?.message || err);
  }
};

module.exports = { sendSkuRateNotification };