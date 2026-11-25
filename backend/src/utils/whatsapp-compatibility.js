// whatsapp-web.js 1.34.7 expects MsgKey._serialized. Newer WhatsApp Web
// exposes MsgKey.$1, which otherwise makes IndexedDB lookups use undefined.
// Patch the library's injected helper before Client captures it. This leaves
// installed dependency files intact and applies on every browser injection.
const injected = require("whatsapp-web.js/src/util/Injected/Utils");

const source = injected.LoadUtils.toString();
let compatibleSource = source;
for (const key of ["newMsgKey", "msg.id", "chat.lastReceivedKey"]) {
  compatibleSource = compatibleSource.replaceAll(
    `${key}._serialized`,
    `(${key}._serialized || ${key}["$1"])`,
  );
}

compatibleSource = compatibleSource.replace(
  "const msg = message.serialize();",
  `const msg = message.serialize();
        if (msg.id && !msg.id._serialized && msg.id["$1"]) {
            msg.id = { ...msg.id, _serialized: msg.id["$1"] };
        }`,
);

if (compatibleSource !== source) {
  // The function source comes exclusively from the installed library.
  injected.LoadUtils = Function(`return (${compatibleSource});`)();
}

const { Client } = require("whatsapp-web.js");

// The public /login page exposes its official QR before the application's
// Socket module exists. Wait through that page instead of crashing in AuthStore.
class CompatibleClient extends Client {
  async inject() {
    if (this.loginInjection) return this.loginInjection;
    this.loginInjection = this.injectAfterLogin();
    try {
      return await this.loginInjection;
    } finally {
      this.loginInjection = null;
    }
  }

  async injectAfterLogin() {
    let previousQr = null;
    while (true) {
      const login = await this.pupPage.evaluate(() => {
        if (location.pathname !== "/login/") return { waiting: false };
        const socket = window.require?.("WAWebSocketModel")?.Socket;
        return {
          waiting: !socket,
          qr: document.querySelector("[data-ref]")?.getAttribute("data-ref"),
        };
      });
      if (!login.waiting) break;
      if (login.qr && login.qr !== previousQr) {
        previousQr = login.qr;
        this.emit("qr", login.qr);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return super.inject();
  }
}

module.exports = { Client: CompatibleClient };
