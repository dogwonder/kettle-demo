import {
  addStatement, join, analyse, overlaps, linesCsv, paymentsCsv, emptyState, rootOf, money, wholePounds, starts, whatsNew, newCsv,
} from './regulars-ops.js';
import { bindFilePicker } from './file-picker.js';
const $ = id => document.getElementById(id);
const MAX_BYTES = 5 * 1024 * 1024;

// Nothing is stored: statements, renames, merges and the £ limit are in this window's memory only.
let files = [];                        // { name, text, statement }
let unsaved = false;                   // renames or merges not yet in a saved list
let state = emptyState();
let analysis = null, breaks = new Set(), openLines = new Set(), tailOpen = false, groupKeys = new Set();
let since = null;                      // the date "new" is counted from; null is the latest statement
let found = null, openNew = new Set();


const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const status = message => { $('status').textContent = message; };
const invoke = window.__TAURI__?.core?.invoke;
const hosted = new URLSearchParams(location.search).get('kettle') === '1' && Boolean(invoke);
// Renames and merges exist only in this window until the list is saved, so Kettle's quit check asks first.
function publishSession() {
  if (hosted) invoke('cup_state', { dirty: unsaved, busy: false })
    .catch(() => status('Kettle could not track this session. Keep the window open.'));
}

// ---- Adding files -------------------------------------------------------------------------

async function addFiles(chosen) {
  const problems = [];
  let added = 0;
  for (const file of chosen) {
    if (!file.size || file.size > MAX_BYTES) { problems.push(`${file.name}: choose a CSV file up to 5 MB.`); continue; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { problems.push(`${file.name}: this could not be read as UTF-8 text.`); continue; }
    if (text.includes('\0')) { problems.push(`${file.name}: this does not look like a CSV file.`); continue; }
    const next = addStatement(files, { name: file.name, text });
    if (next.problem) { problems.push(next.problem); continue; }
    files = next.files;
    added++;
  }
  showNotices(problems);
  render();
  if (problems.length) $('notices').focus();
  else if (added) (breaksOrProblems() ? $('problems') : $('result-title')).focus();
  status(added ? `${plural(added, 'file')} added.` : problems.length ? 'No file was added.' : '');
}
function showNotices(problems) {
  $('notice-list').replaceChildren(...problems.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  $('notices').hidden = !problems.length;
}
const breaksOrProblems = () => files.some(f => f.statement.breaks.length || f.statement.problems.length);
bindFilePicker({ input: $('file'), buttons: [$('choose-file')], zone: $('picker'), accept: addFiles });

// ---- Drawing --------------------------------------------------------------------------------

function nameOf(key) { return state.names[key] || key; }

function render() {
  publishSession();
  const hasFiles = files.length > 0;
  $('files-section').hidden = !hasFiles; $('result').hidden = !hasFiles; $('new').hidden = !hasFiles;
  if (!hasFiles) { analysis = null; found = null; return; }
  drawFiles();
  const statements = files.map(f => ({ name: f.name, ...f.statement }));
  const rows = join(statements);
  groupKeys = new Set(rows.map(r => r.key));
  analysis = analyse(rows, state);
  drawResult();
  const from = starts(statements);
  if (!from.some(s => s.first === since)) since = null;         // that statement was removed
  found = whatsNew(rows, since ?? from[from.length - 1]?.first ?? null, state);
  drawNew(from);
}

function drawFiles() {
  $('file-list').replaceChildren(...files.map(f => {
    const s = f.statement, item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${f.name}: ${plural(s.payments.length, 'payment')} out, balance checked ${plural(s.checks, 'time')}${s.breaks.length ? `, ${plural(s.breaks.length, 'break')}` : ''}`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'govuk-link k-text-button'; remove.dataset.remove = f.name;
    remove.innerHTML = `Remove<span class="govuk-visually-hidden"> ${esc(f.name)}</span>`;
    item.append(text, remove);
    return item;
  }));
  const found = [];
  for (const f of files) {
    for (const b of f.statement.breaks) found.push(`${f.name}, row ${b.row}: the statement prints a balance of ${money(b.printed)}, but the balance before it and the money in and out since give ${money(b.expected)}.`);
    for (const p of f.statement.problems) found.push(`${f.name}, row ${p.row}: ${p.what}. This row was left out.`);
  }
  breaks = new Set(files.flatMap(f => f.statement.breaks.map(b => `${f.name}#${b.row}`)));
  $('problems').hidden = !found.length;
  $('problems-title').textContent = found.length ? `${plural(found.length, 'row')} to check before you rely on the list` : '';
  $('problem-list').replaceChildren(...found.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  const pairs = overlaps(files.map(f => ({ name: f.name, ...f.statement })));
  $('overlap').hidden = !pairs.length;
  $('overlap').textContent = pairs.length
    ? `${pairs.map(([a, b]) => `${a} and ${b}`).join('; ')} cover some of the same dates. A payment that is in both files is counted twice. Remove one of them.` : '';
}

const paymentsTable = (rows, caption) => `<table class="govuk-table payments"><caption class="govuk-visually-hidden">${esc(caption)}</caption><thead class="govuk-table__head"><tr class="govuk-table__row"><th scope="col" class="govuk-table__header">Date</th><th scope="col" class="govuk-table__header">Paid by</th><th scope="col" class="govuk-table__header">Bank’s description</th><th scope="col" class="govuk-table__header govuk-table__header--numeric">Paid out</th></tr></thead><tbody class="govuk-table__body">${rows.map(r => `<tr class="govuk-table__row"><td class="govuk-table__cell">${fmtDate(r.date)}</td><td class="govuk-table__cell">${esc(r.code || '-')}</td><td class="govuk-table__cell">${esc(r.description)}${breaks.has(`${r.file}#${r.row}`) ? ' <strong class="govuk-tag govuk-tag--red">Balance check failed on this row</strong>' : ''}</td><td class="govuk-table__cell govuk-table__cell--numeric">${money(r.pence)}</td></tr>`).join('')}</tbody></table>`;
const alsoHtml = keys => keys.length ? ` Also includes: ${keys.map(k => `${esc(nameOf(k))} (<button type="button" class="govuk-link k-text-button" data-split="${esc(k)}">Split out<span class="govuk-visually-hidden"> ${esc(nameOf(k))}</span></button>)`).join(', ')}.` : '';
const byName = lines => [...lines].sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));

function lineHtml(line, number, all, index) {
  const others = byName(all.filter(o => o.key !== line.key));
  const also = line.keys.slice(1);
  const notes = line.changes.map(c => `<span class="line-note">${money(c.from)} → ${money(c.to)} from ${fmtDate(c.date)}</span>`).join('')
    + (line.stale ? `<span class="line-note"><strong>Last paid ${fmtDate(line.last)}</strong></span>` : '');
  return `<li><details class="line" data-key="${esc(line.key)}"${openLines.has(line.key) ? ' open' : ''}>
    <summary><span class="line-name">${number}. ${esc(line.name)}</span>: ${esc(line.rhythm)}, ${esc(line.typical)}, <strong>${wholePounds(line.year)} a year</strong>${notes}</summary>
    <div class="line-body">
      <p class="small">First paid ${fmtDate(line.first)}, last paid ${fmtDate(line.last)}. ${plural(line.payments, 'payment')}, paid by ${esc(line.paidBy)}. The bank’s name: ${esc(line.key)}.${alsoHtml(also)}</p>
      <div class="line-forms">
        <form data-form="rename" data-key="${esc(line.key)}"><div class="govuk-form-group"><label class="govuk-label" for="rename-${index}">Name</label><input id="rename-${index}" name="name" class="govuk-input govuk-input--width-20" value="${esc(line.name)}" maxlength="200" autocomplete="off"></div><button class="govuk-button govuk-button--secondary">Rename</button></form>
        <form data-form="merge" data-key="${esc(line.key)}"><div class="govuk-form-group"><label class="govuk-label" for="merge-${index}">Merge into</label><select id="merge-${index}" name="into" class="govuk-select"><option value="">Choose a line</option>${others.map(o => `<option value="${esc(o.key)}">${esc(o.name)}</option>`).join('')}</select></div><button class="govuk-button govuk-button--secondary">Merge</button></form>
      </div>
      ${paymentsTable(line.rows, `Payments in ${line.name}`)}
    </div></details></li>`;
}

function drawResult() {
  const a = analysis;
  $('period').textContent = a.lines.length || a.payments
    ? `${fmtDate(a.start)} to ${fmtDate(a.end)} (${plural(a.days, 'day')}). Paid out only. A line needs 3 or more payments in 3 or more calendar months.${a.days === 365 ? '' : ` A year is scaled from these ${a.days} days.`}`
    : 'These files hold no payments out.';
  const named = Object.keys(state.names).filter(k => groupKeys.has(k)).length, merged = Object.keys(state.merges).filter(k => groupKeys.has(k)).length;
  $('summary').textContent = `${plural(a.lines.length, 'line')}. ${named} renamed, ${merged} merged. ${a.lines.filter(l => l.changes.length).length} with a price change, ${a.lines.filter(l => l.stale).length} not paid lately.`;
  $('undo').hidden = !(named || merged);
  $('min-year').value = String(state.minYear);
  $('none').hidden = a.lines.length > 0;
  $('list').innerHTML = a.shown.map((l, i) => lineHtml(l, i + 1, a.lines, i)).join('');
  $('tail').hidden = !a.small.length;
  $('tail').open = tailOpen && a.small.length > 0;
  $('tail-summary').textContent = `Under ${wholePounds(state.minYear)} a year: ${plural(a.small.length, 'more line')}, ${wholePounds(a.smallYear)} a year together`;
  $('tail-list').start = a.shown.length + 1;
  $('tail-list').innerHTML = a.small.map((l, i) => lineHtml(l, a.shown.length + i + 1, a.lines, a.shown.length + i)).join('');
}

// A name with no payment before the date. The bank's own description is shown up front when every payment has the same one,
// because the part the rules drop (a place, a seller) is often what tells two payments apart.
function firstHtml(entry, index, lines) {
  const descriptions = [...new Set(entry.rows.map(r => r.description.trim()))];
  const when = entry.payments === 1 ? `on ${fmtDate(entry.first)}` : `in ${plural(entry.payments, 'payment')}, ${fmtDate(entry.first)} to ${fmtDate(entry.last)}`;
  const detail = descriptions.length === 1 && descriptions[0] !== entry.name ? `<span class="line-note">${esc(descriptions[0])}</span>` : '';
  const others = byName(lines.filter(o => o.key !== entry.key));
  return `<li><details class="first-time" data-new="${esc(entry.key)}"${openNew.has(entry.key) ? ' open' : ''}>
    <summary><span class="line-name">${esc(entry.name)}</span>: <strong>${money(entry.totalPence)}</strong> ${when}${detail}</summary>
    <div class="line-body">
      <p class="small">Paid by ${esc(entry.paidBy)}. No payment to this name before ${fmtDate(found.since)} in the statements you added. The bank’s name: ${esc(entry.key)}.${alsoHtml(entry.keys.slice(1))}</p>
      ${others.length ? `<div class="line-forms"><form data-form="merge" data-key="${esc(entry.key)}"><div class="govuk-form-group"><label class="govuk-label" for="belongs-${index}">This is one of my regulars</label><select id="belongs-${index}" name="into" class="govuk-select"><option value="">Choose a line</option>${others.map(o => `<option value="${esc(o.key)}">${esc(o.name)}</option>`).join('')}</select></div><button class="govuk-button govuk-button--secondary">Merge</button></form></div>` : ''}
      ${paymentsTable(entry.rows, `Payments to ${entry.name}`)}
    </div></details></li>`;
}

function drawNew(from) {
  const latest = from[from.length - 1], first = found.firstTime;
  const title = !latest || found.since === latest.first ? 'New in the latest statement' : `New since ${fmtDate(found.since)}`;
  $('new-title').textContent = title;
  $('new-none').hidden = found.earlier; $('new-found').hidden = !found.earlier; $('new-link').hidden = !found.earlier;
  if (!found.earlier) return;
  const counts = `${plural(first.length, 'name')} paid for the first time`;
  $('new-link').firstElementChild.textContent = `${title}: ${counts}`;
  $('since-group').hidden = from.length < 2;
  $('since').replaceChildren(...[...from].reverse().map(s => new Option(`${fmtDate(s.first)}, the first payment in ${s.name}`, s.first, false, s.first === found.since)));
  $('new-summary').textContent = `Since ${fmtDate(found.since)}: ${counts}.${first.length ? ` The first-time names were paid ${money(first.reduce((sum, n) => sum + n.totalPence, 0))} together.` : ''} “First time” means not in the earlier statements you added.`;
  $('first-list').hidden = !first.length;
  $('first-list').innerHTML = first.map((entry, i) => firstHtml(entry, i, analysis.lines)).join('');
  $('download-new').hidden = !first.length;
}

function focusLine(key) {
  const details = [...document.querySelectorAll('details.line')].find(d => d.dataset.key === key);
  if (!details) return $('result-title').focus();
  if (details.closest('#tail') && !$('tail').open) { $('tail').open = true; tailOpen = true; }
  details.querySelector('summary').focus();
}

// ---- Changes the person makes ------------------------------------------------------------------

function changed(message, focusKey) { unsaved = true; render(); focusLine(focusKey); status(message); }

document.addEventListener('submit', event => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const key = form.dataset.key;
  if (form.dataset.form === 'rename') {
    const name = form.elements.name.value.trim();
    if (name && name !== key) { state.names[key] = name; openLines.add(key); return changed(`Renamed to ${name}.`, key); }
    delete state.names[key]; openLines.add(key);
    return changed(`Name put back to the bank’s name, ${key}.`, key);
  }
  const into = form.elements.into.value;
  if (!into) return status('Choose a line to merge into.');
  const target = rootOf(into, state.merges);
  if (target === key) return status('That line is already part of the one you chose.');
  state.merges[key] = target; openLines.delete(key); openLines.add(target);
  changed(`Merged ${nameOf(key)} into ${nameOf(target)}.`, target);
});

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.split) {
    const key = button.dataset.split;
    delete state.merges[key]; openLines.add(key);
    changed(`${nameOf(key)} split out into a line of its own, if it has enough payments to be a regular.`, key);
  } else if (button.dataset.remove) {
    files = files.filter(f => f.name !== button.dataset.remove);
    showNotices([]); render(); status(`${button.dataset.remove} removed.`);
    $('choose-file').focus();
  }
});

$('undo').addEventListener('click', () => {
  state.names = Object.create(null); state.merges = Object.create(null);
  unsaved = true; render(); status('All renames and merges undone.'); $('result-title').focus();
});
$('min-year').addEventListener('change', () => {
  const value = Number($('min-year').value);
  if ($('min-year').value.trim() === '' || !Number.isFinite(value) || value < 0) { $('min-year').value = String(state.minYear); return status('Enter a number of pounds, zero or more.'); }
  state.minYear = value; render(); status(`Lines under ${wholePounds(value)} a year are in the collapsed section.`);
});

// Details do not bubble their toggle, so listen while it travels down.
document.addEventListener('toggle', event => {
  const details = event.target;
  if (details.id === 'tail') tailOpen = details.open;
  else if (details.dataset?.key !== undefined) details.open ? openLines.add(details.dataset.key) : openLines.delete(details.dataset.key);
  else if (details.dataset?.new !== undefined) details.open ? openNew.add(details.dataset.new) : openNew.delete(details.dataset.new);
}, true);

// In Kettle, a native save dialog; in a browser, the browser's downloads.
async function download(filename, content, what) {
  if (hosted) {
    try {
      const done = await invoke('save_csv', { filename, content });
      if (done && filename === 'regulars.csv') { unsaved = false; publishSession(); }
      status(done ? `${what} saved as CSV.` : 'Not saved. The list is still here.');
    }
    catch { status('The CSV could not be saved. Check the destination and try again.'); }
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(`${what} was sent to your browser’s downloads as ${filename}.`);
}
$('download').addEventListener('click', () => download('regulars.csv', linesCsv(analysis.lines), 'The list'));
$('download-payments').addEventListener('click', () => download('regulars-payments.csv', paymentsCsv(analysis.lines), 'Every payment behind the lines'));
$('download-new').addEventListener('click', () => download('regulars-new.csv', newCsv(found), 'What is new'));
$('since').addEventListener('change', () => {
  since = $('since').selectedIndex === 0 ? null : $('since').value;   // the first choice is the latest statement, and follows it
  render();
  status(`Counting as new from ${fmtDate(found.since)}.`);
});

render();
if (hosted) {
  $('return-kettle').hidden = false;
  const back = () => invoke('show_chooser').catch(() => status('Kettle could not open. Your list is still here.'));
  $('return-kettle').addEventListener('click', back);
  document.querySelector('.wordmark')?.addEventListener('click', event => { event.preventDefault(); back(); });
}
