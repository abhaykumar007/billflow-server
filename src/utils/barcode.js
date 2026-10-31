// Barcode helpers. A barcode is only an ID number printed as stripes; the price and GST come from the item it belongs to.

// What a scanner (or a person) typed, cleaned up: no spaces or line breaks, capitals. Scanners often add a trailing Enter.
function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f\s]+/g, '').toUpperCase();
}

// Allowed: 4 to 48 characters, letters, digits and . _ / -  (covers EAN/UPC numbers and Code 128 text).
const CODE_RE = /^[A-Z0-9][A-Z0-9._/-]{3,47}$/;
function codeProblem(code) {
  if (!code) return 'Barcode is required';
  if (!CODE_RE.test(code)) return 'Barcode must be 4 to 48 letters, digits or . _ / - (no spaces)';
  return null;
}

// GS1 check digit (EAN-8, UPC-A, EAN-13, ITF-14): weights 3,1,3,1… from the right, over the digits before the check digit.
function gs1CheckDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

const GS1_LENGTHS = [8, 12, 13, 14];
const isDigits = (s) => /^[0-9]+$/.test(s);
function hasValidGs1Check(code) {
  return isDigits(code) && GS1_LENGTHS.includes(code.length) && gs1CheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

// A numeric code of a standard length whose last digit does not match: probably a typing slip. A warning, not a refusal,
// because some shops use their own numbers.
function checkDigitWarning(code) {
  if (isDigits(code) && GS1_LENGTHS.includes(code.length) && !hasValidGs1Check(code)) {
    return `The last digit does not match the standard check digit for a ${code.length}-digit barcode. If you typed it by hand, check it; if you scanned it, it is fine to keep.`;
  }
  return null;
}

// Our own codes: EAN-13 starting with 2 (GS1 keeps 20 to 29 for in-store use, so they cannot clash with a manufacturer's code),
// then an 11-digit running number, then the check digit.
function ownCodeFor(n) {
  const body = `2${String(n).padStart(11, '0')}`;
  if (body.length !== 12) throw new Error('barcode counter out of range');
  return body + gs1CheckDigit(body);
}

// How to draw a code: standard retail formats when the numbers allow it, Code 128 for anything else.
function barcodeFormat(code) {
  if (hasValidGs1Check(code)) {
    if (code.length === 13) return 'ean13';
    if (code.length === 12) return 'upca';
    if (code.length === 8) return 'ean8';
  }
  return 'code128';
}

module.exports = { normalizeCode, codeProblem, gs1CheckDigit, hasValidGs1Check, checkDigitWarning, ownCodeFor, barcodeFormat, CODE_RE };
