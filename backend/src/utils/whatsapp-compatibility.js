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
