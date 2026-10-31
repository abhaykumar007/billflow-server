// Printable barcode labels: A4 sticker sheets and small thermal labels. Like the bill page, user text is escaped,
// the page carries a content rule (no network, no scripts) and the barcodes are drawn here as inline SVG.

const bwipjs = require('bwip-js');
const { barcodeFormat } = require('../utils/barcode');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((paise || 0) / 100);

// Sizes are in millimetres. Sheets are laid out edge to edge from the top left, like common sticker sheets.
const LAYOUTS = {
  // Edge-to-edge sticker sheets put the outer columns right at the paper edge, where most printers cannot print (about 3 to 6 mm
  // is left blank). A wide side padding keeps the bars inside the printable area.
  'a4-24': { label: 'A4 sheet, 24 labels (70 x 37 mm)', sheet: { cols: 3, rows: 8, w: 70, h: 37, padX: 0, padY: 0.5 }, pad: '1.2mm 7mm', name: 9, code: 7.5, price: 10 },
  'a4-65': { label: 'A4 sheet, 65 labels (38 x 21 mm)', sheet: { cols: 5, rows: 13, w: 38.1, h: 21.2, padX: 9.75, padY: 10.7 }, name: 6.5, code: 5.5, price: 7 },
  'thermal-50x25': { label: 'Thermal label 50 x 25 mm', single: { w: 50, h: 25 }, name: 8, code: 7, price: 9 },
  'thermal-38x25': { label: 'Thermal label 38 x 25 mm', single: { w: 38, h: 25 }, name: 7, code: 6, price: 8 },
};
const DEFAULT_LAYOUT = 'a4-24';

const svgCache = new Map();
function barsSvg(code) {
  if (svgCache.has(code)) return svgCache.get(code);
  const bcid = barcodeFormat(code);
  const svg = bwipjs.toSVG({ bcid, text: code, includetext: false, scale: 2, height: 12, paddingwidth: 2 });
  // let the page size the drawing: it fills the space and keeps its shape
  const out = svg.replace('<svg ', '<svg class="bars" preserveAspectRatio="xMidYMid meet" ');
  if (svgCache.size > 500) svgCache.clear();
  svgCache.set(code, out);
  return out;
}

function labelHtml(l, opts, spec) {
  const name = opts.show_name ? `<div class="n">${esc(String(l.name).slice(0, 60))}</div>` : '';
  const price = opts.show_price ? `<span class="p">${esc(inr(l.price))}</span>` : '';
  const code = opts.show_code ? `<span class="c">${esc(l.code)}</span>` : '<span></span>';
  return `<div class="lbl">${name}${barsSvg(l.code)}<div class="r">${code}${price}</div></div>`;
}

function css(spec) {
  const cell = spec.sheet || spec.single;
  const page = spec.sheet ? 'A4' : `${spec.single.w}mm ${spec.single.h}mm`;
  return `
@page{size:${page};margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
${spec.sheet
    ? `.sheet{width:210mm;height:297mm;padding:${spec.sheet.padY}mm ${spec.sheet.padX}mm;display:grid;grid-template-columns:repeat(${spec.sheet.cols},${spec.sheet.w}mm);grid-auto-rows:${spec.sheet.h}mm;page-break-after:always;overflow:hidden}`
    : ''}
.lbl{width:${cell.w}mm;height:${cell.h}mm;padding:${spec.pad || '1.2mm 1.8mm'};display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;${spec.single ? 'page-break-after:always;' : ''}}
.n{font-size:${spec.name}pt;font-weight:bold;line-height:1.1;max-height:2.2em;overflow:hidden}
.bars{flex:1 1 auto;min-height:0;width:100%}
.r{display:flex;justify-content:space-between;align-items:baseline;gap:2mm}
.c{font-family:'Courier New',monospace;font-size:${spec.code}pt;letter-spacing:.3px}
.p{font-size:${spec.price}pt;font-weight:bold;white-space:nowrap}
.hint{font:12px Arial;color:#555;padding:8px}
@media print{.hint{display:none}}
`;
}

// labels: [{ name, code, price }]  (already repeated for copies); returns a full HTML page.
function renderLabels({ labels, layout, show_name = true, show_price = true, show_code = true }) {
  const spec = LAYOUTS[layout] || LAYOUTS[DEFAULT_LAYOUT];
  const opts = { show_name: show_name !== false, show_price: show_price !== false, show_code: show_code !== false };
  let body;
  if (spec.sheet) {
    const perSheet = spec.sheet.cols * spec.sheet.rows;
    const sheets = [];
    for (let i = 0; i < labels.length; i += perSheet) {
      sheets.push(`<div class="sheet">${labels.slice(i, i + perSheet).map((l) => labelHtml(l, opts, spec)).join('')}</div>`);
    }
    body = sheets.join('');
  } else {
    body = labels.map((l) => labelHtml(l, opts, spec)).join('');
  }
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Barcode labels</title><style>${css(spec)}</style></head><body>${body}</body></html>`;
}

module.exports = { renderLabels, LAYOUTS, DEFAULT_LAYOUT };
