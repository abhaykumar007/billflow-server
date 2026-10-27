// Turns (invoice + business + design) into one printable HTML page. The web app and the phone app both show/print
// this page, so a bill looks the same everywhere. Every piece of user text is escaped; colours, fonts and sizes
// only ever come from the design allow-lists, and images are validated data URLs.

const QRCode = require('qrcode');
const { amountInWords } = require('../utils/words');
const { effectiveDesign, validateImage, validateUpi } = require('./billDesign');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const multi = (s) => esc(s).replace(/\r?\n/g, '<br>');
const inr = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((paise || 0) / 100);
const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(dt);
};
const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4));

const PAPER = {
  a4: { css: 'A4', width: '210mm', minHeight: '297mm', pad: '12mm 14mm', base: 12, thermal: false },
  a5: { css: 'A5', width: '148mm', minHeight: '210mm', pad: '8mm 9mm', base: 10.5, thermal: false },
  t80: { css: '80mm auto', width: '72mm', minHeight: '0', pad: '3mm', base: 11, thermal: true },
  t58: { css: '58mm auto', width: '48mm', minHeight: '0', pad: '2mm', base: 10, thermal: true },
};
const FONT_STACK = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', Courier, monospace",
};
const SIZE_DELTA = { small: -1, medium: 0, large: 1 };
const LOGO_HEIGHT = { small: 32, medium: 48, large: 68 };
const TITLE_KEY = { SALE: 'title_sale', PURCHASE: 'title_purchase', SALE_RETURN: 'title_sale_return', PURCHASE_RETURN: 'title_purchase_return', ESTIMATE: 'title_estimate' };

function gstType(partyState, businessState, partyGstin, businessGstin) {
  if (!partyGstin && !businessGstin) return 'none';
  if (!partyState || !businessState) return 'none';
  return String(partyState).toLowerCase().trim() === String(businessState).toLowerCase().trim() ? 'intra' : 'inter';
}

// Tax per GST rate, from the amounts the server stored on each line.
function taxByRate(items) {
  const map = new Map();
  for (const it of items) {
    if (it.tax_rate > 0 && it.tax_amount > 0) map.set(it.tax_rate, (map.get(it.tax_rate) || 0) + it.tax_amount);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([rate, amount]) => ({ rate, amount }));
}

function taxLines(items, type, invoice) {
  const rows = taxByRate(items);
  if (type === 'none') return invoice.tax_amount > 0 ? [{ label: 'Tax', value: invoice.tax_amount }] : [];
  const out = [];
  for (const r of rows) {
    if (type === 'inter') out.push({ label: `IGST (${num(r.rate)}%)`, value: r.amount });
    else {
      const half = Math.round(r.amount / 2);
      out.push({ label: `CGST (${num(r.rate / 2)}%)`, value: half }, { label: `SGST (${num(r.rate / 2)}%)`, value: r.amount - half });
    }
  }
  return out;
}

async function upiQrSvg(business, invoice, withAmount) {
  const pa = String(business.upi_id).trim();
  let link = `upi://pay?pa=${pa}&pn=${encodeURIComponent(String(business.name || '').slice(0, 60))}&cu=INR&tn=${encodeURIComponent(invoice.invoice_number || '')}`;
  if (withAmount) link += `&am=${(invoice.balance_due / 100).toFixed(2)}`;
  return QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

function buildColumns(design, labels) {
  const c = design.columns;
  const cols = [];
  if (c.serial) cols.push({ key: 'serial', label: labels.col_serial, align: 'left', w: '28px' });
  cols.push({ key: 'description', label: labels.col_description, align: 'left' });
  if (c.hsn) cols.push({ key: 'hsn', label: labels.col_hsn, align: 'left' });
  cols.push({ key: 'qty', label: labels.col_qty, align: 'right' });
  if (c.unit) cols.push({ key: 'unit', label: labels.col_unit, align: 'left' });
  if (c.rate) cols.push({ key: 'rate', label: labels.col_rate, align: 'right' });
  if (c.discount) cols.push({ key: 'discount', label: labels.col_discount, align: 'right' });
  if (c.tax_rate) cols.push({ key: 'tax', label: labels.col_tax, align: 'right' });
  cols.push({ key: 'amount', label: labels.col_amount, align: 'right' });
  return cols;
}
function cell(col, it, idx) {
  switch (col.key) {
    case 'serial': return String(idx + 1);
    case 'description': return esc(it.description);
    case 'hsn': return esc(it.product?.hsn_code || '');
    case 'qty': return num(it.quantity);
    case 'unit': return esc(it.unit);
    case 'rate': return inr(it.rate);
    case 'discount': return it.discount_percent > 0 ? `${num(it.discount_percent)}%` : '—';
    case 'tax': return `${num(it.tax_rate)}%`;
    case 'amount': return inr(it.amount);
    default: return '';
  }
}

function css(design, spec, accent) {
  const delta = spec.thermal ? 0 : SIZE_DELTA[design.font_size] || 0;
  const base = spec.base + delta;
  const layout = spec.thermal ? 'thermal' : design.layout;
  const small = Math.max(base - 1.5, 8);
  const modern = layout === 'modern';
  const compact = layout === 'compact';
  return `
@page{size:${spec.css};margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{font-family:${FONT_STACK[design.font]};font-size:${base}px;color:#1a1a1a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{position:relative;width:${spec.width};min-height:${spec.minHeight};margin:0 auto;padding:${spec.pad};background:#fff}
p{margin:0}
.gray{color:#555;font-size:${small}px;margin-top:2px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:12px;margin-bottom:14px;${modern ? `background:${accent};color:#fff;padding:14px;border-radius:6px` : `border-bottom:2px solid ${accent}`}}
.hdr .gray{${modern ? 'color:#e5e7eb' : ''}}
.biz{display:flex;gap:12px;align-items:flex-start}
.biz.right{flex-direction:row-reverse}
.biz img{width:auto;object-fit:contain;flex-shrink:0}
.biz-name{font-size:${base + 6}px;font-weight:bold;color:${modern ? '#fff' : accent}}
.doc{text-align:right}
.doc-title{font-size:${base + 8}px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:${modern ? '#fff' : accent}}
.doc-no{font-weight:bold;font-size:${base + 1}px;margin-top:4px}
.due{color:${modern ? '#fecaca' : '#dc2626'};font-size:${small}px;margin-top:2px}
.party{padding:${compact ? '6px 0' : '9px 12px'};margin-bottom:14px;${compact ? `border-bottom:1px solid #e2e8f0` : 'background:#f1f5f9;border-radius:4px'}}
.lbl{font-size:${small - 0.5}px;color:#888;text-transform:uppercase;letter-spacing:1px;font-weight:bold;margin-bottom:4px}
.party-name{font-weight:bold;font-size:${base + 1}px}
.linked{background:#fff7ed;border:1px solid #fed7aa;border-radius:4px;padding:6px 12px;margin-bottom:14px;font-size:${small}px;color:#92400e}
table.items{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:${base - 0.5}px}
table.items thead{display:table-header-group}
table.items tr{page-break-inside:avoid}
table.items th{padding:${compact ? '4px 6px' : '7px 8px'};font-weight:600;${compact ? `border-top:1px solid ${accent};border-bottom:1px solid ${accent};color:${accent}` : modern ? `background:${accent}1a;color:${accent};border-bottom:2px solid ${accent}` : `background:${accent};color:#fff`}}
table.items td{padding:${compact ? '3px 6px' : '6px 8px'};border-bottom:1px solid #e9eef4;vertical-align:top}
table.items tbody tr:nth-child(even) td{${compact ? '' : 'background:#f8fafc'}}
.two{display:flex;justify-content:space-between;gap:28px}
.left{flex:1;font-size:${small + 0.5}px}
.right{min-width:${spec.thermal ? '0' : '210px'}}
.tr{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid #efefef;font-size:${base}px}
.tr.total{border-top:2px solid ${accent};border-bottom:none;font-weight:bold;font-size:${base + 2}px;padding:7px 0 4px}
.tr.paid{color:#16a34a}
.tr.bal{font-weight:bold;border-bottom:none;padding-top:5px}
.words{margin:6px 0 10px;font-size:${small + 0.5}px;color:#333}
.words b{color:#111}
.note{margin-bottom:8px;line-height:1.5;color:#444}
.extras{display:flex;gap:24px;align-items:flex-start;margin-top:16px;flex-wrap:wrap}
.box{font-size:${small}px;line-height:1.5}
.qr svg{width:${spec.thermal ? '34mm' : '28mm'};height:${spec.thermal ? '34mm' : '28mm'};display:block}
.sig{margin-left:auto;text-align:center;min-width:150px}
.sig img{max-height:54px;max-width:180px;object-fit:contain;display:block;margin:4px auto}
.sig .line{border-top:1px solid #999;padding-top:3px;margin-top:6px;font-size:${small}px}
.foot{margin-top:24px;border-top:1px solid #e2e8f0;padding-top:8px;text-align:center;color:#999;font-size:${small - 0.5}px}
.stamp{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:72px;font-weight:bold;letter-spacing:8px;color:#16a34a;opacity:.1;border:8px solid #16a34a;padding:0 24px;border-radius:12px;pointer-events:none}
.center{text-align:center}
.dash{border-top:1px dashed #666;margin:5px 0}
.t-row{display:flex;justify-content:space-between;gap:6px}
`;
}

function headerHtml(ctx) {
  const { design, business, invoice, labels, title, logoSrc } = ctx;
  const h = design.header;
  const logo = h.logo && logoSrc ? `<img src="${esc(logoSrc)}" alt="" style="height:${LOGO_HEIGHT[h.logo_size]}px">` : '';
  const addr = [business.address, business.city, business.state, business.pincode].filter(Boolean).join(', ');
  const lines = [
    h.name ? `<p class="biz-name">${esc(business.name)}</p>` : '',
    h.address && addr ? `<p class="gray">${esc(addr)}</p>` : '',
    h.gstin && business.gstin ? `<p class="gray">GSTIN: ${esc(business.gstin)}</p>` : '',
    h.phone && business.phone ? `<p class="gray">Ph: ${esc(business.phone)}</p>` : '',
    h.email && business.email ? `<p class="gray">${esc(business.email)}</p>` : '',
  ].join('');
  return `<div class="hdr"><div class="biz ${h.logo_position === 'right' ? 'right' : ''}">${logo}<div>${lines}</div></div>
<div class="doc"><p class="doc-title">${esc(title)}</p><p class="doc-no">${esc(invoice.invoice_number)}</p><p class="gray">Date: ${fmtDate(invoice.invoice_date)}</p>${invoice.valid_until && invoice.voucher_type === 'ESTIMATE' ? `<p class="gray">Valid until: ${fmtDate(invoice.valid_until)}</p>` : ''}${invoice.due_date && invoice.voucher_type !== 'ESTIMATE' ? `<p class="due">Due: ${fmtDate(invoice.due_date)}</p>` : ''}</div></div>`;
}

function partyHtml(ctx) {
  const { party, design, labels, isPurchase } = ctx;
  if (!party) return '';
  const addr = [party.address, party.city, party.state].filter(Boolean).join(', ');
  return `<div class="party"><p class="lbl">${esc(isPurchase ? labels.supplier : labels.bill_to)}</p><p class="party-name">${esc(party.name)}</p>
${design.party.phone && party.phone ? `<p class="gray">${esc(party.phone)}</p>` : ''}${design.party.address && addr ? `<p class="gray">${esc(addr)}</p>` : ''}${design.party.gstin && party.gstin ? `<p class="gray">GSTIN: ${esc(party.gstin)}</p>` : ''}</div>`;
}

function totalsHtml(ctx) {
  const { invoice, design, taxRows, isReturn } = ctx;
  const rows = [`<div class="tr"><span>Subtotal</span><span>${inr(invoice.subtotal)}</span></div>`];
  if (invoice.discount_amount > 0) rows.push(`<div class="tr"><span>Discount</span><span>- ${inr(invoice.discount_amount)}</span></div>`);
  if (design.totals.tax_breakup) for (const t of taxRows) rows.push(`<div class="tr"><span>${esc(t.label)}</span><span>${inr(t.value)}</span></div>`);
  rows.push(`<div class="tr total"><span>Total</span><span>${inr(invoice.total_amount)}</span></div>`);
  if (invoice.amount_paid > 0) {
    rows.push(`<div class="tr paid"><span>${isReturn ? 'Credit Applied' : 'Amount Paid'}</span><span>- ${inr(invoice.amount_paid)}</span></div>`);
    rows.push(`<div class="tr bal"><span>Balance Due</span><span style="color:${invoice.balance_due > 0 ? '#dc2626' : '#16a34a'}">${inr(invoice.balance_due)}</span></div>`);
  }
  return rows.join('');
}

function paymentsHtml(ctx) {
  const { invoice, design } = ctx;
  if (!design.totals.payments || !invoice.payments?.length) return '';
  return `<div style="margin-top:10px"><p class="lbl">Payment History</p>${invoice.payments.map((p) => `<div class="t-row" style="font-size:inherit;color:#555;margin-bottom:3px"><span style="text-transform:capitalize">${esc(p.payment_mode || '')}${p.reference_number ? ` – ${esc(p.reference_number)}` : ''}</span><span style="color:#16a34a">${inr(p.amount)} on ${fmtDate(p.payment_date)}</span></div>`).join('')}</div>`;
}

function renderStandard(ctx) {
  const { invoice, design, labels, columns } = ctx;
  const head = columns.map((c) => `<th style="text-align:${c.align};${c.w ? `width:${c.w}` : ''}">${esc(c.label)}</th>`).join('');
  const body = invoice.items.map((it, i) => `<tr>${columns.map((c) => `<td style="text-align:${c.align}${c.key === 'description' ? ';font-weight:500' : ''}">${cell(c, it, i)}</td>`).join('')}</tr>`).join('');
  const x = design.extras;
  const leftBits = [
    design.totals.amount_in_words ? `<p class="words"><b>Amount in words:</b> ${esc(amountInWords(invoice.total_amount))}</p>` : '',
    x.notes && invoice.notes ? `<div class="note"><p class="lbl">Notes</p>${multi(invoice.notes)}</div>` : '',
    x.terms && invoice.terms ? `<div class="note"><p class="lbl">Terms &amp; Conditions</p>${multi(invoice.terms)}</div>` : '',
    paymentsHtml(ctx),
  ].join('');
  const extraBoxes = [
    ctx.bankHtml ? `<div class="box"><p class="lbl">Bank details</p>${ctx.bankHtml}</div>` : '',
    ctx.qrSvg ? `<div class="box qr"><p class="lbl">Scan to pay</p>${ctx.qrSvg}<p class="gray">${esc(ctx.business.upi_id)}</p></div>` : '',
    ctx.showSignature ? `<div class="sig"><p class="gray">For ${esc(ctx.business.name)}</p>${ctx.signatureSrc ? `<img src="${esc(ctx.signatureSrc)}" alt="">` : '<div style="height:44px"></div>'}<div class="line">${esc(x.signatory_text)}</div></div>` : '',
  ].join('');
  return `${headerHtml(ctx)}
${invoice.linked_invoice && ctx.isReturn ? `<div class="linked">Against: ${esc(invoice.linked_invoice.invoice_number)} dated ${fmtDate(invoice.linked_invoice.invoice_date)}</div>` : ''}
${partyHtml(ctx)}
<table class="items"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="two"><div class="left">${leftBits}</div><div class="right">${totalsHtml(ctx)}</div></div>
${extraBoxes ? `<div class="extras">${extraBoxes}</div>` : ''}
<div class="foot">${x.footer_text ? `${esc(x.footer_text)}<br>` : ''}${x.computer_generated ? `This is a computer generated ${esc(ctx.title.toLowerCase())} &nbsp;·&nbsp; ${esc(ctx.business.name)}${ctx.business.gstin ? ` &nbsp;·&nbsp; GSTIN: ${esc(ctx.business.gstin)}` : ''}` : ''}</div>`;
}

function renderThermal(ctx) {
  const { invoice, design, business, party, title } = ctx;
  const h = design.header;
  const x = design.extras;
  const addr = [business.address, business.city, business.state].filter(Boolean).join(', ');
  const logo = h.logo && ctx.logoSrc ? `<img src="${esc(ctx.logoSrc)}" alt="" style="max-height:${Math.round(LOGO_HEIGHT[h.logo_size] * 0.8)}px;max-width:100%;object-fit:contain;display:block;margin:0 auto 3px">` : '';
  const items = invoice.items.map((it) => `<div>${esc(it.description)}</div><div class="t-row"><span>${num(it.quantity)} ${esc(it.unit)} × ${inr(it.rate)}${it.discount_percent > 0 ? ` (-${num(it.discount_percent)}%)` : ''}</span><span>${inr(it.amount)}</span></div>`).join('<div class="dash" style="border-top-style:dotted"></div>');
  return `<div class="center">${logo}${h.name ? `<p style="font-weight:bold;font-size:1.2em">${esc(business.name)}</p>` : ''}${h.address && addr ? `<p class="gray">${esc(addr)}</p>` : ''}${h.gstin && business.gstin ? `<p class="gray">GSTIN: ${esc(business.gstin)}</p>` : ''}${h.phone && business.phone ? `<p class="gray">Ph: ${esc(business.phone)}</p>` : ''}</div>
<div class="dash"></div>
<div class="center"><p style="font-weight:bold;text-transform:uppercase">${esc(title)}</p></div>
<div class="t-row"><span>${esc(invoice.invoice_number)}</span><span>${fmtDate(invoice.invoice_date)}</span></div>
${party ? `<div>${esc(party.name)}${design.party.phone && party.phone ? ` · ${esc(party.phone)}` : ''}</div>${design.party.gstin && party.gstin ? `<div class="gray">GSTIN: ${esc(party.gstin)}</div>` : ''}` : ''}
<div class="dash"></div>${items}<div class="dash"></div>
${totalsHtml(ctx)}
${design.totals.amount_in_words ? `<p class="words">${esc(amountInWords(invoice.total_amount))}</p>` : ''}
${ctx.bankHtml ? `<div class="dash"></div><div class="box">${ctx.bankHtml}</div>` : ''}
${ctx.qrSvg ? `<div class="dash"></div><div class="box qr center"><p class="gray">Scan to pay</p><div style="display:inline-block">${ctx.qrSvg}</div></div>` : ''}
<div class="dash"></div>
<div class="center gray">${x.footer_text ? `${esc(x.footer_text)}<br>` : ''}${x.computer_generated ? 'Thank you' : ''}</div>`;
}

async function renderBill({ invoice, business, design: rawDesign, paper, bank }) {
  const design = effectiveDesign(rawDesign, business);
  const spec = PAPER[paper] || PAPER[design.paper] || PAPER.a4;
  const labels = design.labels;
  const type = invoice.voucher_type || 'SALE';
  const isPurchase = type === 'PURCHASE' || type === 'PURCHASE_RETURN';
  const isReturn = type === 'SALE_RETURN' || type === 'PURCHASE_RETURN';
  const party = invoice.customer || invoice.supplier || null;
  const gType = gstType(party?.state, business.state, party?.gstin, business.gstin);
  const logoSrc = validateImage(business.logo_data) ? business.logo_data : (/^https:\/\//i.test(business.logo_url || '') ? business.logo_url : '');
  const signatureSrc = validateImage(business.signature_data) ? business.signature_data : '';
  const title = labels[TITLE_KEY[type]] || 'Invoice';
  const sellsToCustomer = type === 'SALE' || type === 'ESTIMATE';

  let bankHtml = '';
  if (design.extras.bank && sellsToCustomer && bank) {
    bankHtml = [
      bank.account_name ? `A/c name: ${esc(bank.account_name)}` : '',
      bank.bank_name ? `Bank: ${esc(bank.bank_name)}` : '',
      bank.account_number ? `A/c no: ${esc(bank.account_number)}` : '',
      bank.ifsc_code ? `IFSC: ${esc(bank.ifsc_code)}` : '',
    ].filter(Boolean).join('<br>');
  }

  let qrSvg = '';
  if (design.extras.upi_qr && type === 'SALE' && invoice.status !== 'paid' && invoice.balance_due > 0 && validateUpi(business.upi_id)) {
    qrSvg = await upiQrSvg(business, invoice, design.extras.upi_with_amount);
  }

  const ctx = {
    invoice, business, design, labels, spec, party, isPurchase, isReturn, title, logoSrc, signatureSrc, bankHtml, qrSvg,
    taxRows: taxLines(invoice.items, gType, invoice),
    columns: buildColumns(design, labels),
    showSignature: design.extras.signature && (type === 'SALE' || type === 'SALE_RETURN' || type === 'ESTIMATE'),
  };
  const stamp = design.extras.paid_stamp && type === 'SALE' && invoice.status === 'paid' ? '<div class="stamp">PAID</div>' : '';
  const body = spec.thermal ? renderThermal(ctx) : renderStandard(ctx);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} ${esc(invoice.invoice_number)}</title><style>${css(design, spec, design.accent)}</style></head><body><div class="page">${stamp}${body}</div></body></html>`;
}

// A made-up bill for the live preview in settings (real business details, invented customer and items).
function sampleInvoice(business) {
  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const due = new Date(base.getTime() + 15 * 86400000);
  const items = [
    { id: 's1', description: 'Wireless keyboard', quantity: 2, unit: 'pcs', rate: 150000, discount_percent: 10, tax_rate: 18, tax_amount: 48600, amount: 270000, product: { hsn_code: '8471' } },
    { id: 's2', description: 'Notebook A5 (pack of 10)', quantity: 5, unit: 'box', rate: 45000, discount_percent: 0, tax_rate: 12, tax_amount: 27000, amount: 225000, product: { hsn_code: '4820' } },
    { id: 's3', description: 'Delivery charge', quantity: 1, unit: 'pcs', rate: 20000, discount_percent: 0, tax_rate: 0, tax_amount: 0, amount: 20000, product: null },
  ];
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const tax = items.reduce((s, i) => s + i.tax_amount, 0);
  const total = subtotal + tax;
  const paid = 200000;
  return {
    id: 'sample', invoice_number: 'INV-2627-0001', voucher_type: 'SALE', status: 'partial', invoice_date: base, due_date: due,
    subtotal, discount_amount: 0, tax_amount: tax, total_amount: total, amount_paid: paid, balance_due: total - paid,
    notes: 'Thank you for your business!', terms: 'Payment due within 15 days. Goods once sold will not be taken back.',
    customer: { name: 'Sample Customer Pvt Ltd', phone: '9876543210', address: '12 Market Road', city: 'Pune', state: business.state || 'Maharashtra', gstin: '27AAAAA0000A1Z5' },
    items, payments: [{ id: 'p1', payment_mode: 'upi', reference_number: 'UTR12345', amount: paid, payment_date: base }],
  };
}

module.exports = { renderBill, sampleInvoice, taxLines, gstType };
