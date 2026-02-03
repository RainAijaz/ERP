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
    case "22P02": // invalid_text_representation
      return local("error_invalid_value", "One or more values are invalid.");
    default:
      return null;
  }
};

const friendlyErrorMessage = (err, t) => {
  if (!err) return typeof t === "function" ? t("error_generic") : DEFAULT_MESSAGE;
  const local = (key, fallback) => (typeof t === "function" ? t(key) : fallback);

  if (typeof err === "string") {
    if (err.toLowerCase().includes("violates foreign key constraint")) {
      return local("error_record_in_use", "This record is linked to other data and cannot be deleted.");
    }
    return err;
  }

  const mapped = messageFromCode(err.code, t);
  if (mapped) return mapped;

  if (typeof err.message === "string" && err.message.toLowerCase().includes("violates foreign key constraint")) {
    return local("error_record_in_use", "This record is linked to other data and cannot be deleted.");
  }

  return err.message || local("error_generic", DEFAULT_MESSAGE);
};

module.exports = { friendlyErrorMessage };
