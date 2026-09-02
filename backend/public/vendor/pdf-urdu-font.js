/**
 * Urdu/Arabic font support for the client-side jsPDF exports.
 *
 * jsPDF defaults to Helvetica, a standard-14 PDF font locked to WinAnsiEncoding
 * (Latin-1). Urdu codepoints get truncated to their low byte on the way into the
 * content stream -- U+FEB3 becomes 0xB3 -- so an Urdu ledger exported to PDF came
 * out as strings like "u§þþý" instead of text. The fix is to
 * embed a real Unicode TTF, which flips the font to Identity-H encoding.
 *
 * Font choice is not interchangeable here. jsPDF's bundled Arabic shaper rewrites
 * letters to Arabic Presentation Forms (U+FB50-FDFF, U+FE70-FEFF) before drawing,
 * so the font's cmap must contain those codepoints. Nastaliq faces (including
 * Windows' "Urdu Typesetting") carry almost none of them -- they rely on OpenType
 * shaping that jsPDF cannot run -- and would render blank boxes. Noto Naskh Arabic
 * covers all of Forms-B and 631 of Forms-A, so it is what ships here.
 *
 * Do NOT call doc.setR2L(true) alongside this. jsPDF's bidi engine already emits
 * correct visual order; setR2L adds a naive whole-string reverse on top, which
 * turns "1,234" into "432,1" and "Ali" into "ilA".
 */
(function () {
  var FONT_URL = "/vendor/fonts/NotoNaskhArabic-Regular.ttf";
  var VFS_NAME = "NotoNaskhArabic-Regular.ttf";
  var FONT_NAME = "NotoNaskhArabic";

  // Same ranges jsPDF's own arabic parser uses to decide a character needs shaping.
  var ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

  var base64Promise = null;

  var toBase64 = function (buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000; // apply() blows the stack on a 300KB spread
    var chunks = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(
        String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)),
      );
    }
    return btoa(chunks.join(""));
  };

  // Fetched once per page load, then reused for every subsequent export.
  var loadFontBase64 = function () {
    if (base64Promise) return base64Promise;
    base64Promise = fetch(FONT_URL)
      .then(function (res) {
        if (!res.ok) throw new Error("Font request failed with " + res.status);
        return res.arrayBuffer();
      })
      .then(toBase64)
      .catch(function (err) {
        base64Promise = null; // let a later export retry a transient failure
        throw err;
      });
    return base64Promise;
  };

  window.__pdfUrduFont = {
    name: FONT_NAME,

    /** True when `text` contains anything Helvetica would mangle. */
    isNeededFor: function (text) {
      return ARABIC_RE.test(String(text || ""));
    },

    /**
     * Registers the Unicode font on `doc` when `sampleText` actually contains
     * Arabic-script characters, and returns the font name to hand to autoTable's
     * `styles.font`. Resolves to null when the font is not needed or could not be
     * fetched, in which case callers should carry on with jsPDF's default font --
     * a Latin-only report must not fail to export because of this.
     */
    ensure: function (doc, sampleText) {
      if (!this.isNeededFor(sampleText)) return Promise.resolve(null);
      return loadFontBase64()
        .then(function (base64) {
          doc.addFileToVFS(VFS_NAME, base64);
          doc.addFont(VFS_NAME, FONT_NAME, "normal");
          // Registered for "bold" as well, pointing at the same regular file.
          // autoTable asks for bold on highlighted/total rows, and an
          // unregistered style silently falls back to Helvetica -- which would
          // mangle exactly the rows a reader is most likely to be looking at.
          // The text renders un-bolded rather than wrong; the row fill still
          // carries the emphasis.
          doc.addFont(VFS_NAME, FONT_NAME, "bold");
          doc.setFont(FONT_NAME, "normal");
          return FONT_NAME;
        })
        .catch(function (err) {
          console.error(
            "Urdu PDF font unavailable, falling back to Helvetica",
            err,
          );
          return null;
        });
    },
  };
})();
