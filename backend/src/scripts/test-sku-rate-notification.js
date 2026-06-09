const assert = require("assert");

const whatsappModulePath = require.resolve("../utils/whatsapp");
const sentMessages = [];

require.cache[whatsappModulePath] = {
  id: whatsappModulePath,
  filename: whatsappModulePath,
  loaded: true,
  exports: {
    sendWhatsAppMessage: async (chatId, text) => {
      sentMessages.push({ chatId, text });
    },
  },
};

const { sendSkuRateNotification } = require("../utils/sku-rate-notification");

const createFakeKnex = (rows) => {
  const query = {
    select() {
      return query;
    },
    leftJoin() {
      return query;
    },
    whereIn() {
      return Promise.resolve(rows);
    },
  };

  return () => query;
};

const run = async () => {
  const directRows = [
    { id: 101, item_name: "Demo Item", sku_code: "SKU-101" },
  ];
  await sendSkuRateNotification({
    knex: createFakeKnex(directRows),
    chatId: "1203630@example.us",
    updates: [{ id: 101, newRate: 150, oldRate: 100 }],
    user: { username: "admin-user" },
  });

  assert.strictEqual(sentMessages.length, 1, "expected one WhatsApp message");
  assert.strictEqual(sentMessages[0].chatId, "1203630@example.us");
  assert.match(sentMessages[0].text, /Rate Update Alert/);
  assert.match(sentMessages[0].text, /By: admin-user/);
  assert.match(sentMessages[0].text, /SKU-101/);
  assert.match(sentMessages[0].text, /Demo Item/);
  assert.match(sentMessages[0].text, /Rs\. 150/);
  assert.match(sentMessages[0].text, /Rs\. 100/);

  sentMessages.length = 0;
  await sendSkuRateNotification({
    knex: createFakeKnex(directRows),
    chatId: "1203630@example.us",
    updates: [{ id: 101, newRate: 175, oldRate: 150 }],
    user: { name: "approver-user" },
    approved: true,
  });

  assert.strictEqual(sentMessages.length, 1, "expected approval WhatsApp message");
  assert.match(sentMessages[0].text, /By: approver-user \(approved\)/);
  assert.match(sentMessages[0].text, /Rs\. 175/);
  assert.match(sentMessages[0].text, /Rs\. 150/);

  console.log("SKU rate notification helper test passed.");
};

run().catch((err) => {
  console.error("SKU rate notification helper test failed:", err);
  process.exitCode = 1;
});