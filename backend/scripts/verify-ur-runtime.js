const middleware = require("../src/middleware/core/locale");

const req = {
  query: { lang: "ur" },
  headers: {},
};

const res = {
  locals: {},
  getHeader() {
    return undefined;
  },
  setHeader() {},
};

middleware(req, res, () => {
  const keys = ["add_user", "approval_submitted", "leave_blank_keep", "permissions", "status", "line"];
  const marker = /[ØÙÛÃâÚ¢€ž�]/;
  for (const key of keys) {
    const value = res.locals.t(key);
    console.log(`${key}: ${value} | bad=${marker.test(value)}`);
  }
});
