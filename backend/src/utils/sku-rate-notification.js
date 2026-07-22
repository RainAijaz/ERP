const { sendWhatsAppMessage } = require("./whatsapp");

const formatRate = (value) => {
  if (value == null) return null;
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
  isNew = false,
}) => {
  if (!chatId || !String(chatId).trim()) return;

  const normalizedUpdates = Array.isArray(updates)
    ? updates
        .map((update) => ({
          id: Number(update?.id),
          newRate: update?.newRate ?? update?.rate ?? update?.new_rate ?? update?.sale_rate ?? null,
          oldRate: update?.oldRate ?? update?.old_rate ?? null,
        }))
        .filter((update) => Number.isInteger(update.id) && update.id > 0)
    : [];

  if (!normalizedUpdates.length) return;

  try {
    const details = await knex("erp.variants as v")
      .select("v.id", "i.name as item_name", "i.name_ur as item_name_ur", "k.sku_code", "pg.name as group_name")
      .leftJoin("erp.items as i", "v.item_id", "i.id")
      .leftJoin("erp.skus as k", "k.variant_id", "v.id")
      .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
      .whereIn(
        "v.id",
        normalizedUpdates.map((update) => update.id),
      );

    const detailMap = new Map(details.map((row) => [Number(row.id), row]));
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
      const nameUr = detail?.item_name_ur || "";
      const groupName = detail?.group_name || "";
      const newRateStr = formatRate(update.newRate);
      const oldRateStr = formatRate(update.oldRate);

      const oldNumeric = Number(update.oldRate);
      const newNumeric = Number(update.newRate);
      const bothValid =
        Number.isFinite(oldNumeric) &&
        Number.isFinite(newNumeric) &&
        oldRateStr &&
        newRateStr;

      let rateLine;
      let arrow = "";
      if (bothValid) {
        if (newNumeric > oldNumeric) arrow = " ↑";
        else if (newNumeric < oldNumeric) arrow = " ↓";
        rateLine = `  پہلے: ${oldRateStr}  ←  بعد: ${newRateStr || "-"}${arrow}`;
      } else {
        rateLine = `  ریٹ: ${newRateStr || "-"}`;
      }

      const groupSuffix = groupName ? ` (${groupName})` : "";
      const nameLine = nameUr ? `  ${name} | ${nameUr}${groupSuffix}` : `  ${name}${groupSuffix}`;
      return `• *${sku}*\n${nameLine}\n${rateLine}`;
    });

    let header;
    if (isNew) {
      header = approved ? "🆕 *نیا آرٹیکل* _(منظور شدہ)_" : "🆕 *نیا آرٹیکل*";
    } else {
      header = approved ? "🔔 *ریٹ اپ ڈیٹ* _(منظور شدہ)_" : "🔔 *ریٹ اپ ڈیٹ*";
    }
    const message = `${header}\n📅 ${timeStr}\n\n${lines.join("\n\n")}`;
    await sendWhatsAppMessage(chatId, message);
  } catch (err) {
    console.error("[WhatsApp] SKU rate notify error:", err?.message || err);
  }
};

module.exports = { sendSkuRateNotification };