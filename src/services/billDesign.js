// The bill design is DATA: a fixed set of options, never HTML or CSS from the user.
// Everything is cleaned against the allow-lists below, so a saved design can only ever pick from known choices.

const LAYOUTS = ['classic', 'modern', 'compact'];
const FONTS = ['sans', 'serif', 'mono'];
const FONT_SIZES = ['small', 'medium', 'large'];
const PAPERS = ['a4', 'a5', 't80', 't58'];
const LOGO_SIZES = ['small', 'medium', 'large'];
const LOGO_POSITIONS = ['left', 'right'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_CHARS = 400000; // about 300 KB of image

const DEFAULT_LABELS = {
  title_sale: 'Tax Invoice',
  title_purchase: 'Purchase Bill',
  title_sale_return: 'Credit Note',
  title_purchase_return: 'Debit Note',
  title_estimate: 'Estimate',
  bill_to: 'Bill To',
  supplier: 'Supplier',
  col_serial: '#',
  col_description: 'Description',
  col_hsn: 'HSN/SAC',
  col_qty: 'Qty',
  col_unit: 'Unit',
  col_rate: 'Rate (₹)',
  col_discount: 'Disc%',
  col_tax: 'GST%',
  col_amount: 'Amount (₹)',
};

const DEFAULT_DESIGN = {
  version: 1,
  layout: 'classic',
  accent: '#1e3a8a',
  font: 'sans',
  font_size: 'medium',
  paper: 'a4',
  header: { logo: true, logo_size: 'medium', logo_position: 'left', name: true, address: true, gstin: true, phone: true, email: true },
  party: { phone: true, address: true, gstin: true },
  columns: { serial: true, hsn: false, unit: true, rate: true, discount: true, tax_rate: true },
  labels: { ...DEFAULT_LABELS },
  totals: { amount_in_words: true, tax_breakup: true, payments: true },
  extras: { bank: false, bank_account_id: null, upi_qr: false, upi_with_amount: true, signature: true, signatory_text: 'Authorised Signatory', notes: true, terms: true, footer_text: '', computer_generated: true, paid_stamp: true },
};

// Fields a GST tax invoice must carry. They cannot be switched off for a GST-registered business.
const GST_LOCKED = ['header.name', 'header.address', 'header.gstin', 'party.gstin', 'columns.tax_rate', 'totals.tax_breakup'];

const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const text = (v, max, dflt) => {
  if (typeof v !== 'string') return dflt;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
};

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = val;
}

function lockedPaths(business) {
  return business && business.gstin ? GST_LOCKED : [];
}

// Clean any input into a complete, valid design. Unknown keys are dropped, bad values fall back to the default.
function sanitizeDesign(input, business) {
  const d = input && typeof input === 'object' ? input : {};
  const h = d.header || {}; const p = d.party || {}; const c = d.columns || {}; const l = d.labels || {};
  const t = d.totals || {}; const x = d.extras || {};
  const D = DEFAULT_DESIGN;

  const labels = {};
  for (const k of Object.keys(DEFAULT_LABELS)) {
    const v = text(l[k], 40, '');
    labels[k] = v || DEFAULT_LABELS[k];
  }

  const out = {
    version: 1,
    layout: pick(d.layout, LAYOUTS, D.layout),
    accent: typeof d.accent === 'string' && COLOR_RE.test(d.accent) ? d.accent.toLowerCase() : D.accent,
    font: pick(d.font, FONTS, D.font),
    font_size: pick(d.font_size, FONT_SIZES, D.font_size),
    paper: pick(d.paper, PAPERS, D.paper),
    header: {
      logo: bool(h.logo, D.header.logo), logo_size: pick(h.logo_size, LOGO_SIZES, D.header.logo_size), logo_position: pick(h.logo_position, LOGO_POSITIONS, D.header.logo_position),
      name: bool(h.name, true), address: bool(h.address, true), gstin: bool(h.gstin, true), phone: bool(h.phone, true), email: bool(h.email, true),
    },
    party: { phone: bool(p.phone, true), address: bool(p.address, true), gstin: bool(p.gstin, true) },
    columns: {
      serial: bool(c.serial, true), hsn: bool(c.hsn, false), unit: bool(c.unit, true), rate: bool(c.rate, true), discount: bool(c.discount, true), tax_rate: bool(c.tax_rate, true),
    },
    labels,
    totals: { amount_in_words: bool(t.amount_in_words, true), tax_breakup: bool(t.tax_breakup, true), payments: bool(t.payments, true) },
    extras: {
      bank: bool(x.bank, false),
      bank_account_id: typeof x.bank_account_id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.bank_account_id) ? x.bank_account_id : null,
      upi_qr: bool(x.upi_qr, false), upi_with_amount: bool(x.upi_with_amount, true),
      signature: bool(x.signature, true), signatory_text: text(x.signatory_text, 60, D.extras.signatory_text),
      notes: bool(x.notes, true), terms: bool(x.terms, true), footer_text: text(x.footer_text, 200, ''),
      computer_generated: bool(x.computer_generated, true), paid_stamp: bool(x.paid_stamp, true),
    },
  };
  return enforceRequired(out, business);
}

// A GST-registered business cannot hide what a tax invoice must show.
function enforceRequired(design, business) {
  const out = JSON.parse(JSON.stringify(design));
  for (const path of lockedPaths(business)) setPath(out, path, true);
  return out;
}

// What is saved (or the defaults) merged into a full design, with locks applied.
function effectiveDesign(saved, business) {
  return sanitizeDesign(saved || {}, business);
}

function validateUpi(v) { return typeof v === 'string' && UPI_RE.test(v.trim()); }
function validateImage(v) { return typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(v); }

module.exports = {
  DEFAULT_DESIGN, DEFAULT_LABELS, GST_LOCKED, LAYOUTS, FONTS, FONT_SIZES, PAPERS,
  sanitizeDesign, effectiveDesign, enforceRequired, lockedPaths, validateUpi, validateImage, getPath, MAX_IMAGE_CHARS,
};
