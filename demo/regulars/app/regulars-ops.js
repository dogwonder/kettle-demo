// Regulars' one task source: pure functions shared by the page, regulars.mjs and the tests.
// No DOM, network, storage, clock or randomness. Ported from the #73 check-1 prototype
// (grouping rules, joining, balance check, rhythm, price changes, last paid); amounts are whole pence.

export const MIN_PAYMENTS = 3;          // a regular line has 3+ payments...
export const MIN_MONTHS = 3;            // ...in 3+ calendar months
export const DEFAULT_MIN_YEAR = 100;    // lines under this a year go in the collapsed section
const PROCESSOR_MAX = 6;                // "SQ *SHOP", "SUMUP *SHOP": keep the part after the star
const STALE_FLOOR_DAYS = 45;

// Which Tables text column is which, per bank. The only bank-specific part; a bank's layout is read in Tables.
export const BANKS = { hsbc: { code: 'text 1', description: 'text 2' } };

export class StatementError extends Error {}

// ---- Reading a Tables CSV -------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, started = false;
  const endCell = () => { row.push(cell); cell = ''; started = true; };
  const endRow = () => { if (started || cell) { endCell(); rows.push(row); } row = []; started = false; };
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && !cell) { quoted = true; started = true; }
    else if (c === ',') endCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i + 1] === '\n') i++; endRow(); }
    else cell += c;
  }
  if (quoted) throw new StatementError('A quoted cell is never closed. This does not look like a Tables CSV file.');
  endRow();
  return rows;
}

// "1,234.56", "£4.20", "1,050.00D" (HSBC's overdrawn marker) -> pence; '' -> null; anything else -> NaN.
export function pence(cell) {
  const s = cell.trim().replace(/£/g, '');
  if (!s) return null;
  const m = /^(-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*([DC]?)$/.exec(s);   // "1,234.56" but not "4,2": a comma is only ever thousands
  if (!m) return NaN;
  const value = Math.round(Number(m[1].replace(/,/g, '')) * 100);
  return m[2] === 'D' ? -value : value;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "05 Feb 25", "5 Feb 2025" or "2025-02-05" -> "2025-02-05"; anything else (or a date that does not exist) -> null.
export function isoDate(cell) {
  const s = cell.trim();
  let y, m, d, match;
  if ((match = /^(\d{1,2}) ([A-Za-z]{3})[A-Za-z]* (\d{4}|\d{2})$/.exec(s))) {
    d = Number(match[1]); m = MONTHS.indexOf(match[2].toLowerCase()) + 1; y = Number(match[3]);
    if (y < 100) y += 2000;
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { y = Number(match[1]); m = Number(match[2]); d = Number(match[3]); }
  else return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (!m || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return check.toISOString().slice(0, 10);
}
export const dayNumber = iso => Date.parse(iso) / 864e5;

// One statement -> paid-out payments, plus what the running-balance check found. Never edits a cell.
// breaks: rows where the printed balance differs from the previous balance plus the movements since.
export function readStatement(text, bank = 'hsbc') {
  const layout = BANKS[bank];
  if (!layout) throw new StatementError(`No text-column layout is known for “${bank}”.`);
  const table = parseCsv(text);
  const header = (table[0] || []).map(cell => cell.trim().toLowerCase());
  const need = ['date', layout.code, layout.description, 'paid out', 'paid in', 'balance'];
  const missing = need.filter(name => !header.includes(name));
  if (missing.length) throw new StatementError(`This does not look like a Tables statement CSV. Missing columns: ${missing.join(', ')}.`);
  const at = Object.fromEntries(need.map(name => [name, header.indexOf(name)]));
  const cell = (row, name) => row[at[name]] ?? '';
  const result = { payments: [], balanceOnly: 0, noAmount: 0, blank: 0, checks: 0, breaks: [], problems: [] };
  let previous = null;
  for (let n = 1; n < table.length; n++) {
    const row = table[n], rowNumber = n + 1;             // as the person sees it: the header is row 1
    if (row.every(value => !value.trim())) { result.blank++; continue; }
    const out = pence(cell(row, 'paid out')), inn = pence(cell(row, 'paid in')), balance = pence(cell(row, 'balance'));
    if ([out, inn, balance].some(Number.isNaN)) {
      result.problems.push({ row: rowNumber, what: 'an amount or balance that is not a number' });
      previous = null;                                    // the balance chain restarts after an unreadable row
      continue;
    }
    if (out === null && inn === null) { if (balance !== null) result.balanceOnly++; else result.noAmount++; }
    if (previous !== null) previous += (inn ?? 0) - (out ?? 0);
    if (balance !== null) {
      if (previous !== null) {
        result.checks++;
        if (previous !== balance) result.breaks.push({ row: rowNumber, printed: balance, expected: previous });
      }
      previous = balance;
    }
    if (out === null) continue;
    const date = isoDate(cell(row, 'date'));
    if (!date) { result.problems.push({ row: rowNumber, what: 'a date that is not readable' }); continue; }
    result.payments.push({ date, code: cell(row, layout.code).trim(), description: cell(row, layout.description), pence: out, row: rowNumber });
  }
  return result;
}

// ---- Adding a statement file -----------------------------------------------------------------

// files: [{ name, text, statement }], sorted by name.
// Returns { files, problem }: the new list, or the old one and a sentence saying why nothing was added.
export function addStatement(files, { name, text }) {
  const twin = files.find(f => f.text === text && f.name !== name);
  if (twin) return { files, problem: `${name}: it has exactly the same content as ${twin.name}, which is already here, so it was not added again.` };
  let statement;
  try { statement = readStatement(text); }
  catch (error) { return { files, problem: `${name}: ${error instanceof StatementError ? error.message : 'this could not be read.'}` }; }
  // A file saved again under the same name replaces the earlier one.
  const next = [...files.filter(f => f.name !== name), { name, text, statement }];
  return { files: next.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), problem: null };
}

// ---- Grouping by rule -------------------------------------------------------------------

function clean(part) {
  part = part.toUpperCase().replace(/\.(CO\.UK|COM|UK|NET|ORG)\b/g, ' ');   // "X.CO.UK" -> "X"
  part = part.replace(/'/g, '').replace(/\./g, '');
  const words = part.split(/[^A-Z0-9&]+/).filter(Boolean);
  const kept = words.filter(word => !/\d/.test(word));                       // store numbers, references
  let out = (kept.length ? kept : words).join(' ');                          // "NATURE16" alone is the name: keep it
  out = out.replace(/\b([A-Z]) (?=[A-Z]\b)/g, '$1');                         // "L B" -> "LB"
  return out.replace(/( (UK|GB|LTD|LIMITED|PLC))+$/, '');                   // "AMAZON UK" -> "AMAZON"
}

// The bank's own name for who was paid, by general rules only. Never a list of merchants.
export function groupKey(description) {
  const parts = description.split(' | ');
  let first = parts[0];                                                      // card rows: merchant | location
  if (parts.length > 1 && /^INT'?L \d+$/.test(first.trim())) first = parts[1]; // INT'L ref | merchant | ...
  const star = first.indexOf('*');
  if (star < 0) return clean(first);
  const before = clean(first.slice(0, star));
  let after = clean(first.slice(star + 1));
  if (!/[A-Z]{2}/.test(after.replace(/\S*\d\S*/g, ''))) after = '';          // "AB12CD" after the star is a reference
  if (after && before.replace(/ /g, '').length <= PROCESSOR_MAX) return after;
  return before || after;
}

// ---- Joining and lines --------------------------------------------------------------------

// statements: [{ name, payments }] in the order the person added them. Same-day payments keep that order.
export function join(statements) {
  const rows = [];
  for (const { name, payments } of statements) for (const p of payments) rows.push({ ...p, file: name, key: groupKey(p.description) || '(blank)' });
  return rows.map((row, order) => ({ row, order })).sort((a, b) => a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : a.order - b.order).map(x => x.row);
}

// Pairs of statements whose payment dates overlap by more than a shared boundary day: payments in both would count twice.
export function overlaps(statements) {
  const ranges = statements.map(({ name, payments }) => payments.length
    ? { name, first: payments.reduce((m, p) => p.date < m ? p.date : m, payments[0].date), last: payments.reduce((m, p) => p.date > m ? p.date : m, payments[0].date) } : null);
  const pairs = [];
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
    const a = ranges[i], b = ranges[j];
    if (a && b && a.first < b.last && b.first < a.last) pairs.push([a.name, b.name]);
  }
  return pairs;
}

const median = numbers => {
  if (!numbers.length) return 0;
  const s = [...numbers].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const gbp = pounds => pounds.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
const poundsOf = p => p / 100;
export const money = p => gbp(poundsOf(p));
export const wholePounds = pounds => gbp(Math.round(pounds)).replace('.00', '');

export function rhythm(rows, days) {
  const n = rows.length, weeks = days / 7;
  const dates = rows.map(r => dayNumber(r.date)).sort((a, b) => a - b);
  const med = median(dates.slice(1).map((d, i) => d - dates[i]));
  if (n / weeks >= 1) return n / weeks >= 1.5 ? `about ${Math.round(n / weeks)} times a week` : 'about weekly';
  if (med >= 6 && med <= 8) return 'weekly';
  if (med >= 26 && med <= 35 && n <= days / 26 + 1) return 'monthly';
  return `about ${(n / (days / 30.44)).toFixed(1)} times a month`;
}

// Runs of the same amount, 2+ long, that together hold 80%+ of the payments; at most 3 changes, else none.
export function priceChanges(rows) {
  const runs = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last.pence === r.pence) last.n++; else runs.push({ pence: r.pence, n: 1, from: r.date });
  }
  const kept = runs.filter(run => run.n >= 2);
  if (kept.reduce((sum, run) => sum + run.n, 0) < 0.8 * rows.length) return [];
  const changes = [];
  for (let i = 1; i < kept.length; i++) if (kept[i].pence !== kept[i - 1].pence) changes.push({ from: kept[i - 1].pence, to: kept[i].pence, date: kept[i].from });
  return changes.length <= 3 ? changes : [];
}

// Last paid shows up front when the time since the last payment is more than twice the usual gap (45 days at least).
export function notPaidLately(rows, end) {
  const dates = rows.map(r => dayNumber(r.date));
  const gaps = dates.slice(1).map((d, i) => d - dates[i]);
  return dayNumber(end) - dates[dates.length - 1] > Math.max(2 * median(gaps), STALE_FLOOR_DAYS);
}

export function typical(rows, changes) {
  if (changes.length) return `${money(changes[changes.length - 1].to)} now`;
  const values = rows.map(r => r.pence).sort((a, b) => a - b);
  const m = median(values);
  return values[0] === values[values.length - 1] ? money(m) : `${money(m)} typical (${money(values[0])}–${money(values[values.length - 1])})`;
}

export const emptyState = () => ({ names: Object.create(null), merges: Object.create(null), minYear: DEFAULT_MIN_YEAR });

// merges: bank name -> the line it was merged into. A chain is followed; a loop stops.
export function rootOf(key, merges) {
  const seen = new Set();
  while (merges[key] && !seen.has(key)) { seen.add(key); key = merges[key]; }
  return key;
}

const byDate = rows => rows.map((row, order) => ({ row, order })).sort((a, b) => a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : a.order - b.order).map(x => x.row);
const paidBy = rows => [...new Set(rows.map(r => r.code || '-'))].sort().join('/');

// Bank names joined by the person's merges: the name each was merged into -> its bank names and their payments.
function combine(rows, state) {
  const byKey = new Map();
  for (const r of rows) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); }
  const combined = new Map();
  for (const [key, group] of byKey) {
    const root = rootOf(key, state.merges);
    if (!combined.has(root)) combined.set(root, { keys: [], rows: [] });
    const line = combined.get(root);
    line.keys.push(key); line.rows.push(...group);
  }
  return { groups: byKey.size, combined };
}

// rows: the joined payments. Returns the period, every group's size, and the regular lines,
// sorted by yearly total (largest first; equal totals by name), each split into shown and small.
export function analyse(rows, state = emptyState()) {
  if (!rows.length) return { start: null, end: null, days: 0, payments: 0, groups: 0, lines: [], shown: [], small: [], smallYear: 0 };
  const start = rows.reduce((m, r) => r.date < m ? r.date : m, rows[0].date);
  const end = rows.reduce((m, r) => r.date > m ? r.date : m, rows[0].date);
  const days = dayNumber(end) - dayNumber(start) + 1;
  const { groups, combined } = combine(rows, state);
  const lines = [];
  for (const [key, line] of combined) {
    if (line.rows.length < MIN_PAYMENTS || new Set(line.rows.map(r => r.date.slice(0, 7))).size < MIN_MONTHS) continue;
    const sorted = byDate(line.rows);
    const total = sorted.reduce((sum, r) => sum + r.pence, 0);
    const changes = priceChanges(sorted);
    lines.push({
      key, name: state.names[key] || key,
      keys: [key, ...line.keys.filter(k => k !== key)],
      rows: sorted, payments: sorted.length, totalPence: total, year: poundsOf(total) * 365 / days,
      changes, stale: notPaidLately(sorted, end), rhythm: rhythm(sorted, days), typical: typical(sorted, changes),
      first: sorted[0].date, last: sorted[sorted.length - 1].date,
      paidBy: paidBy(sorted),
    });
  }
  lines.sort((a, b) => b.year - a.year || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const shown = lines.filter(l => l.year >= state.minYear), small = lines.filter(l => l.year < state.minYear);
  return { start, end, days, payments: rows.length, groups, lines, shown, small, smallYear: small.reduce((sum, l) => sum + l.year, 0) };
}

// ---- New since a date -----------------------------------------------------------------------

// Where "new" can be counted from: the first payment date of each statement that has an earlier
// payment in another one, earliest first. The last is the latest statement, which is the default.
export function starts(statements) {
  const firsts = statements.filter(s => s.payments.length)
    .map(s => ({ name: s.name, first: s.payments.reduce((m, p) => p.date < m ? p.date : m, s.payments[0].date) }))
    .sort((a, b) => a.first < b.first ? -1 : a.first > b.first ? 1 : a.name < b.name ? -1 : 1);
  return firsts.filter((s, i) => s.first > firsts[0].first && s.first !== firsts[i - 1].first);
}

// rows: the joined payments; since: a date. A first-time name has no payment before that date, so
// "first time" only ever means "not in the earlier statements added". Every one is listed, however
// small or many, sorted by what was paid, largest first.
export function whatsNew(rows, since, state = emptyState()) {
  if (!since || !rows.some(r => r.date < since)) return { since, earlier: false, firstTime: [] };
  const firstTime = [];
  for (const [key, line] of combine(rows, state).combined) {
    if (line.rows.some(r => r.date < since)) continue;
    const sorted = byDate(line.rows);
    firstTime.push({
      key, name: state.names[key] || key, keys: [key, ...line.keys.filter(k => k !== key)],
      rows: sorted, payments: sorted.length, totalPence: sorted.reduce((sum, r) => sum + r.pence, 0),
      first: sorted[0].date, last: sorted[sorted.length - 1].date, paidBy: paidBy(sorted),
    });
  }
  firstTime.sort((a, b) => b.totalPence - a.totalPence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { since, earlier: true, firstTime };
}

// ---- CSV out -----------------------------------------------------------------------------

const quote = value => /[",\n\r]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
const toCsv = table => table.map(row => row.map(quote).join(',')).join('\n') + '\n';
const change = c => `${(c.from / 100).toFixed(2)} to ${(c.to / 100).toFixed(2)} from ${c.date}`;

export const LINES_HEADER = ['name', 'bank names', 'paid by', 'payments', 'rhythm', 'typical payment', 'price changes', 'first paid', 'last paid', 'total in period', 'a year'];
export const PAYMENTS_HEADER = ['name', 'date', 'paid by', 'bank description', 'paid out'];

export function linesCsv(lines) {
  return toCsv([LINES_HEADER, ...lines.map(l => [l.name, l.keys.join('; '), l.paidBy, l.payments, l.rhythm, l.typical,
    l.changes.map(change).join('; '), l.first, l.last, (l.totalPence / 100).toFixed(2), Math.round(l.year)])]);
}

// Optional: every payment behind the lines, with its line's name.
export function paymentsCsv(lines) {
  return toCsv([PAYMENTS_HEADER, ...lines.flatMap(l => l.rows.map(r => [l.name, r.date, r.code || '-', r.description, (r.pence / 100).toFixed(2)]))]);
}

export const NEW_HEADER = ['name', 'date', 'paid by', 'bank description', 'paid out'];

// What is new since a date: every payment to a first-time name.
export function newCsv(found) {
  return toCsv([NEW_HEADER, ...found.firstTime.flatMap(n => n.rows.map(r => [n.name, r.date, r.code || '-', r.description, (r.pence / 100).toFixed(2)]))]);
}
