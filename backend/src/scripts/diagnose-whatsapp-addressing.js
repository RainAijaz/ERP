/*
 * Why does a payment notification only arrive when a conversation already exists?
 *
 * Since WhatsApp's LID migration, getNumberId() returns a "@lid" id. A "@lid" is
 * only routable once WhatsApp Web holds its lid<->phone binding locally — which
 * it does for anyone you already have a chat with, and does NOT for a number you
 * have never messaged. Addressing an unbound "@lid" makes client.sendMessage()
 * resolve to undefined WITHOUT throwing: no message is created, no ack is ever
 * emitted, and the send silently evaporates.
 *
 * This script proves or disproves that per number. It SENDS NOTHING.
 *
 *   node src/scripts/diagnose-whatsapp-addressing.js 03001234567 03119876543
 *
 * CAVEAT on "existing conversation in store": this script CREATES chat entries as
 * a side effect (getChatById -> findOrCreateLatestChat), so the flag only reflects
 * a genuine pre-existing thread on the FIRST run against a given number in a given
 * session. Re-run it and everything reads true. Trust it once, then stop.
 *
 * Read the output per number:
 *   chatAlreadyInStore=true   -> you already chat with them (the working case)
 *   isLid=true, primedPn=null -> the binding could not be established
 *   addressable: all false    -> resolve returns chat_unavailable, nothing can send
 *   resolved.ok=true          -> the fix can address them; chatIds lists the
 *                                forms the send ladder will try, best first
 */
require("dotenv").config();

const {
  initWhatsApp,
  onWhatsAppReady,
  diagnoseWhatsAppNumber,
  shutdownWhatsApp,
} = require("../utils/whatsapp");
const { normalizePkMobileToChatId } = require("../utils/phone-format");

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(`[${stamp()}]`, ...args);

const waitForReady = (timeoutMs = 120000) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    onWhatsAppReady(() => finish(true));
    setTimeout(() => finish(false), timeoutMs);
    initWhatsApp();
  });

const numbers = process.argv.slice(2).filter((a) => !a.startsWith("--"));

(async () => {
  if (!numbers.length) {
    console.error("usage: node src/scripts/diagnose-whatsapp-addressing.js <number> [number...]");
    process.exit(1);
  }
  if (process.env.WHATSAPP_CLIENT_DISABLED === "1") {
    console.error("WHATSAPP_CLIENT_DISABLED=1 — unset it, this needs the real client");
    process.exit(1);
  }

  log("connecting WhatsApp client (scan /whatsapp-qr if it asks)...");
  if (!(await waitForReady())) {
    console.error("WhatsApp client never reached ready — aborting");
    await shutdownWhatsApp();
    process.exit(1);
  }
  log("client ready\n");

  for (const raw of numbers) {
    const { normalized, reason } = normalizePkMobileToChatId(raw);
    if (!normalized) {
      log(`${raw}: does not normalize (${reason})`);
      continue;
    }
    const d = await diagnoseWhatsAppNumber(normalized);
    log(`=== ${raw} -> ${normalized} ===`);
    log(`  existing conversation in store : ${d.chatAlreadyInStore}`);
    log(`  saved as contact               : ${d.savedContact} ${d.contactName ? `("${d.contactName}")` : ""}`);
    log(`  getNumberId()                  : ${d.getNumberId}  (isLid=${d.isLid})`);
    log(`  primed pn / lid                : ${d.primedPn} / ${d.primedLid}`);
    log(`  addressable forms              :`);
    Object.entries(d.addressable || {}).forEach(([id, ok]) => {
      // null = getChatById threw (it does so for every id on some sessions), which
      // is NOT the same as a refusal — the send still goes ahead.
      const verdict = ok === null ? "  ?" : ok ? "YES" : " NO";
      log(`      ${verdict}  ${id}`);
    });
    log(
      `  resolveWhatsAppChatId()        : ` +
        (d.resolved?.ok
          ? `OK -> ${d.resolved.chatId}  (fallbacks: ${(d.resolved.chatIds || []).slice(1).join(", ") || "none"})`
          : `FAIL ${d.resolved?.reason}`),
    );
    log("");
  }

  await shutdownWhatsApp();
  process.exit(0);
})();
