const DEFAULT_MESSAGE = "Something went wrong. Please try again.";

const messageFromCode = (code, t) => {
  const translate = typeof t === "function" ? t : null;
  const local = (key, fallback) => (translate ? translate(key) : fallback);
  switch (code) {
    case "23503": // foreign_key_violation
      return local("error_record_in_use", "This record is linked to other data and cannot be deleted.");
    case "23505": // unique_violation
      return local("error_duplicate_record", "A record with the same details already exists.");
    case "23502": // not_null_violation
      return local("error_required_fields", "Required fields are missing.");
    default:
      return null;
  }
};

const friendlyErrorMessage = (err, t) => {
  if (String(err?.message || '').includes('salary_period_finalized')) return typeof t === 'function' ? t('salary_period_finalized') : 'This payroll period is finalized.';
  if (String(err?.message || '').includes('salary_frequency_boundary')) return typeof t === 'function' ? t('salary_frequency_boundary') : 'Use a shared salary-period boundary.';
  if (!err) return typeof t === "function" ? t("error_generic") : DEFAULT_MESSAGE;
  if(typeof t==='function' && typeof err.message==='string') {
    const translated=t(err.message);
    if(translated!==err.message)return translated;
  }
  const local = (key, fallback) => (typeof t === "function" ? t(key) : fallback);

  if (String(err.code || "").startsWith("repack_")) {
    return local(err.code, DEFAULT_MESSAGE);
  }

  if (err.code === "DCV_SFG_STOCK_SHORTAGE") {
    const shortage = err.shortage || {};
    return local(
      "dcv_sfg_stock_shortage",
      "DCV cannot post: {sku} needs {required} pairs of SFG in this branch; {available} are available.",
    )
      .replace("{sku}", String(shortage.skuLabel || shortage.skuId || "SFG"))
      .replace("{required}", String(shortage.requiredPairs ?? 0))
      .replace("{available}", String(shortage.availablePairs ?? 0));
  }

  if (typeof err === "string") {
    if (err.toLowerCase().includes("violates foreign key constraint")) {
      return local("error_record_in_use", "This record is linked to other data and cannot be deleted.");
    }
    return err;
  }

  const mapped = messageFromCode(err.code, t);
  if (mapped) return mapped;

  if (typeof err.detail === "string" && err.detail.trim()) {
    return err.detail.trim();
  }
  if (typeof err.hint === "string" && err.hint.trim()) {
    return err.hint.trim();
  }

  if (typeof err.message === "string" && err.message.toLowerCase().includes("violates foreign key constraint")) {
    return local("error_record_in_use", "This record is linked to other data and cannot be deleted.");
  }

  return err.message || local("error_generic", DEFAULT_MESSAGE);
};

const publicErrorMessage = (err,t,{validation=false}={}) => {
  const message=String(err?.message || '');
  const marker=['salary_period_finalized','salary_frequency_boundary'].find(key=>message.includes(key));
  if(marker && t(marker)!==marker)return t(marker);
  const translated=t(message);
  if(message && translated!==message)return translated;
  if(validation && err?.constructor===Error && !err.code && !err.sql)return message || t('generic_error');
  return t('generic_error');
};
module.exports = { friendlyErrorMessage,publicErrorMessage };
