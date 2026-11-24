import { createActivity, createImagePicker, createFileError } from './cup.js';
const $ = id => document.getElementById(id);
let ready = false, active = null, saving = false;
let savedTable = null;
const hosted = new URLSearchParams(location.search).get('kettle') === '1' && Boolean(window.__TAURI__?.core?.invoke);
function hasUnsavedWork() { return Boolean(active || saving || (picker.file && (!rows.length || savedTable !== JSON.stringify(rows)))); }
function publishSession() {
  if (hosted) window.__TAURI__.core.invoke('cup_state', { dirty: hasUnsavedWork(), busy: Boolean(active) || saving })
    .catch(() => status('Kettle could not track this session. Keep the window open and save your work.'));
}
const status = text => { $('status').textContent = text; };
const activity = createActivity();
const fileError = createFileError({ group: $('file-field'), focusTarget: () =>
  $('image-selection').hidden ? $('choose') : $('change-image') });
const imageErrors = new Set(['unsupported_format', 'animated_image', 'image_too_large', 'unreadable_image', 'upload_incomplete',
  'unreadable_pdf', 'scanned_pdf', 'too_many_pages', 'pdf_too_large']);

// Layout is a preference only: switching it never edits cells or clears review.
const layoutKey = 'tables-review-layout';
function applyReviewLayout(value) {
  const layout = value === 'image-above' ? value : 'side-by-side';
  $('result').dataset.layout = layout;
  $(layout === 'image-above' ? 'layout-above' : 'layout-side').checked = true;
}
try {
  const value = window.__TAURI__?.core?.invoke
    ? await window.__TAURI__.core.invoke('review_layout', { value: null })
    : localStorage.getItem(layoutKey);
  applyReviewLayout(value);
} catch { applyReviewLayout('side-by-side'); }
for (const control of document.querySelectorAll('input[name="review-layout"]')) {
  control.addEventListener('change', async () => {
    if (!control.checked) return;
    applyReviewLayout(control.value);
    try {
      if (window.__TAURI__?.core?.invoke) {
        await window.__TAURI__.core.invoke('review_layout', { value: control.value });
      } else localStorage.setItem(layoutKey, control.value);
    } catch { status('Layout changed for this session, but the preference could not be saved.'); }
  });
}

let rows = [];
let realignedCells = new Set();
let preparationFile = null, turns = 0, resultImageURL = null;
// A PDF statement has its own row limit; the image route keeps 100.
let draftPDF = false, balanceRows = new Set(), pageURLs = [];
const rowLimit = () => draftPDF ? 500 : 100;
const gridHint = $('grid-hint').textContent;
const draftHint = $('draft-hint').textContent;
const edges = ['top', 'right', 'bottom', 'left'];
const crop = () => edges.map(edge => Number($(`crop-${edge}`).value));
function validCrop() {
  const [top, right, bottom, left] = crop();
  return edges.every(edge => $(`crop-${edge}`).value !== '' && $(`crop-${edge}`).validity.valid) &&
    top + bottom < 100 && left + right < 100;
}
const hasPreparation = () => turns !== 0 || crop().some(value => value !== 0);
function resetCrop() {
  for (const edge of edges) $(`crop-${edge}`).value = '0';
}
function drawCrop(canvas, preview = false, selectedEdges = crop()) {
  const source = $('preview'), width = source.naturalWidth, height = source.naturalHeight;
  const rotatedWidth = turns % 2 ? height : width, rotatedHeight = turns % 2 ? width : height;
  const [top, right, bottom, left] = selectedEdges;
  const x = Math.round(rotatedWidth * left / 100), y = Math.round(rotatedHeight * top / 100);
  const croppedWidth = Math.max(1, Math.round(rotatedWidth * (1 - right / 100)) - x);
  const croppedHeight = Math.max(1, Math.round(rotatedHeight * (1 - bottom / 100)) - y);
  const scale = preview ? Math.min(1, 1600 / Math.max(croppedWidth, croppedHeight)) : 1;
  canvas.width = Math.max(1, Math.round(croppedWidth * scale));
  canvas.height = Math.max(1, Math.round(croppedHeight * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(canvas.width / croppedWidth, canvas.height / croppedHeight);
  context.translate(-x + rotatedWidth / 2, -y + rotatedHeight / 2);
  context.rotate(-turns * Math.PI / 2);
  context.drawImage(source, -width / 2, -height / 2);
}
function showPreparation() {
  clearResult();
  fileError.clear();
  const valid = validCrop(), prepared = valid && hasPreparation();
  $('preview').hidden = prepared;
  $('crop-preview').hidden = !prepared;
  if (prepared) drawCrop($('crop-preview'), true);
  $('crop-status').textContent = !valid ? 'Enter percentages from 0 to 99.9 in steps of 0.1. Opposite edges must add up to less than 100.' :
    prepared ? 'Selection updated. Only the selected area will be read.' : 'The whole image is selected.';
  showCropBox();
  status('');
  updateDescribe();
}
$('rotate-image').addEventListener('click', () => {
  if (active) return;
  turns = (turns + 1) % 4; resetCrop(); showPreparation(); drawCropSource();
});
$('reset-crop').addEventListener('click', () => {
  if (active) return;
  turns = 0; resetCrop(); showPreparation(); drawCropSource();
});
for (const edge of edges) $(`crop-${edge}`).addEventListener('input', () => {
  if (!active) showPreparation();
});

// The full rotated image stays still while the selection changes. Both the box
// and the uploaded crop use the same edge values; dragging never crops a crop.
function drawCropSource() {
  if (!picker.ready) return;
  const canvas = $('crop-source');
  drawCrop(canvas, true, [0, 0, 0, 0]);
  $('crop-editor').style.width = `min(100%, ${28 * canvas.width / canvas.height}rem)`;
  showCropBox();
}
function showCropBox() {
  const box = $('crop-box');
  box.hidden = !validCrop();
  if (box.hidden) return;
  const [top, right, bottom, left] = crop();
  Object.assign(box.style, { top: `${top}%`, left: `${left}%`, width: `${100 - left - right}%`, height: `${100 - top - bottom}%` });
  for (const button of box.querySelectorAll('button')) {
    const corner = button.dataset.corner;
    button.setAttribute('aria-description', `${corner[0] === 't' ? top : 100 - bottom}% from top, ${corner[1] === 'l' ? left : 100 - right}% from left.`);
  }
}
const tenth = value => Math.round(value * 10) / 10;
function selectRectangle(x1, y1, x2, y2) {
  const values = [Math.min(y1, y2), 100 - Math.max(x1, x2), 100 - Math.max(y1, y2), Math.min(x1, x2)].map(tenth);
  if (values[0] + values[2] >= 100 || values[1] + values[3] >= 100) return;
  edges.forEach((edge, index) => { $(`crop-${edge}`).value = values[index]; });
  showPreparation();
}
function resizeCorner(corner, x, y) {
  const [top, right, bottom, left] = crop();
  // Keep each corner on its own side of the opposite corner.
  const nextX = corner[1] === 'l' ? Math.min(x, tenth(99.9 - right)) : Math.max(x, tenth(left + 0.1));
  const nextY = corner[0] === 't' ? Math.min(y, tenth(99.9 - bottom)) : Math.max(y, tenth(top + 0.1));
  selectRectangle(corner[1] === 'l' ? 100 - right : left, corner[0] === 't' ? 100 - bottom : top, nextX, nextY);
}
let cropDrag = null;
const editor = $('crop-editor');
function cropPoint(event) {
  const rect = $('crop-source').getBoundingClientRect();
  return [tenth(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100))),
    tenth(Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100)))];
}
editor.addEventListener('pointerdown', event => {
  if (active || !picker.ready || !event.isPrimary || event.button !== 0) return;
  const corner = event.target.closest('[data-corner]');
  const [x, y] = cropPoint(event);
  cropDrag = { id: event.pointerId, x, y, corner: corner?.dataset.corner, previous: edges.map(edge => $(`crop-${edge}`).value) };
  editor.setPointerCapture(event.pointerId);
  event.preventDefault();
  corner?.focus({ preventScroll: true });
});
editor.addEventListener('pointermove', event => {
  if (!cropDrag || event.pointerId !== cropDrag.id) return;
  const [x, y] = cropPoint(event);
  if (cropDrag.corner) {
    const [top, right, bottom, left] = cropDrag.previous.map(Number), corner = cropDrag.corner;
    resizeCorner(corner,
      Math.max(0, Math.min(100, (corner[1] === 'l' ? left : 100 - right) + x - cropDrag.x)),
      Math.max(0, Math.min(100, (corner[0] === 't' ? top : 100 - bottom) + y - cropDrag.y)));
  }
  else selectRectangle(cropDrag.x, cropDrag.y, x, y);
});
function finishCropDrag(event) {
  if (!cropDrag || event.pointerId !== cropDrag.id) return;
  if (event.type === 'pointercancel') {
    edges.forEach((edge, index) => { $(`crop-${edge}`).value = cropDrag.previous[index]; });
    showPreparation();
  }
  cropDrag = null;
  if (editor.hasPointerCapture(event.pointerId)) editor.releasePointerCapture(event.pointerId);
}
editor.addEventListener('pointerup', finishCropDrag);
editor.addEventListener('pointercancel', finishCropDrag);
editor.addEventListener('lostpointercapture', finishCropDrag);
editor.addEventListener('keydown', event => {
  const corner = event.target.dataset.corner;
  if (!corner || active || !validCrop() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const [top, right, bottom, left] = crop(), step = event.shiftKey ? 1 : 0.1;
  const x = (corner[1] === 'l' ? left : 100 - right) + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0);
  const y = (corner[0] === 't' ? top : 100 - bottom) + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0);
  resizeCorner(corner, Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y)));
});
$('prepare-image').addEventListener('toggle', () => {
  if ($('prepare-image').open) drawCropSource();
});
async function preparedInput() {
  if (!hasPreparation()) return picker.file;
  const canvas = document.createElement('canvas');
  try {
    drawCrop(canvas);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The crop could not be prepared. Try a smaller image.');
    if (blob.size > 15 * 1024 * 1024) throw new Error('The prepared image exceeds 15 MB. Trim more of the image or choose a smaller copy.');
    return blob;
  } finally { canvas.width = canvas.height = 1; }
}
function invalidateReview() {
  queueMicrotask(publishSession);
  $('reviewed').checked = false;
  $('review-confirmed').hidden = true;
  $('save').disabled = true;
}
function clearResult() {
  $('read-error').hidden = true;
  $('read-error-message').textContent = '';
  if (resultImageURL) URL.revokeObjectURL(resultImageURL);
  resultImageURL = null;
  $('result').hidden = true;
  $('add').hidden = false;
  $('table-preview').removeAttribute('src');
  $('open-original').removeAttribute('href');
  for (const url of pageURLs) URL.revokeObjectURL(url);
  pageURLs = [];
  $('pdf-pages').replaceChildren();
  showDraftKind(false);
  rows = [];
  realignedCells.clear();
  balanceRows.clear();
  $('alignment-hint').hidden = true;
  $('balance-hint').hidden = true;
  $('grid').replaceChildren();
  $('structure-status').textContent = '';
  invalidateReview();
}
function showDraftKind(pdf) {
  draftPDF = pdf;
  $('table-preview').hidden = $('original-caption').hidden = pdf;
  $('pdf-pages').hidden = $('pdf-draft-note').hidden = !pdf;
  $('review-source').textContent = pdf ? 'pages' : 'image';
  $('draft-hint').textContent = pdf ? 'Check the dates, descriptions, amounts and empty cells against the pages. Edit any mistakes before saving.' : draftHint;
  $('grid-hint').textContent = pdf ? 'Each cell can be edited. Row 1 names the columns. Amounts are shown without £ or commas, and an overdrawn balance is negative. Scroll across to see more columns.' : gridHint;
}
function showPages(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 30 || pages.some(page => typeof page !== 'string')) {
    throw new Error('The reader returned incomplete pages. Try downloading a fresh copy of the statement.');
  }
  pages.forEach((page, index) => {
    const bytes = Uint8Array.from(atob(page), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    pageURLs.push(url);
    const figure = document.createElement('figure'), image = document.createElement('img');
    const caption = document.createElement('figcaption'), link = document.createElement('a');
    image.src = url; image.alt = `Page ${index + 1} of ${pages.length} of the statement, shown for checking`;
    link.className = 'govuk-link'; link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = `Open page ${index + 1} at full size (opens in a new tab)`;
    caption.append(link); figure.append(image, caption); $('pdf-pages').append(figure);
  });
}
function showBalance(breaks, steps) {
  balanceRows = new Set(breaks.map(item => item?.row).filter(row => Number.isInteger(row) && row >= 2 && row <= rows.length));
  const checked = Number.isInteger(steps?.checked) ? steps.checked : 0, count = balanceRows.size;
  $('balance-hint').textContent = count ? `${count} ${count === 1 ? 'row is' : 'rows are'} marked where the printed running balance does not add up. Check each marked row, and the rows since the balance before it, against the pages.` :
    checked ? `Every printed running balance adds up (${checked} ${checked === 1 ? 'step' : 'steps'}). This checks the amounts, not the dates or descriptions, so check every cell.` :
    'This statement has no running balance steps to check. Check every amount against the pages.';
  $('balance-hint').hidden = false;
}
function renderGrid() {
  const table = $('grid');
  table.replaceChildren();
  const caption = table.createCaption();
  caption.className = 'govuk-table__caption';
  caption.textContent = 'Draft table';
  const head = table.createTHead().insertRow();
  for (const text of ['Row', ...rows[0].map((_, c) => `Column ${c + 1}`)]) {
    const th = document.createElement('th');
    th.className = 'govuk-table__header'; th.scope = 'col'; th.textContent = text; head.append(th);
  }
  const body = table.createTBody();
  rows.forEach((row, r) => {
    const tr = body.insertRow();
    const th = document.createElement('th');
    th.className = 'govuk-table__header'; th.scope = 'row'; th.textContent = String(r + 1); tr.append(th);
    const balanceNote = balanceRows.has(r + 1) ? `balance-note-${r}` : null;
    if (balanceNote) {
      tr.classList.add('balance-break');
      const note = document.createElement('span');
      note.id = balanceNote; note.className = 'balance-note small'; note.textContent = 'Balance does not add up';
      th.append(note);
    }
    row.forEach((value, c) => {
      const td = tr.insertCell(); td.className = 'govuk-table__cell';
      const input = document.createElement('textarea');
      input.className = 'govuk-textarea'; input.rows = 2; input.maxLength = 2000;
      input.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}`);
      input.value = value;
      if (realignedCells.has(`${r + 1},${c + 1}`)) {
        td.classList.add('position-adjusted');
        const note = document.createElement('p');
        note.id = `position-note-${r}-${c}`;
        note.className = 'small'; note.textContent = 'Check text position';
        input.setAttribute('aria-describedby', note.id);
        td.append(note);
      }
      if (balanceNote) input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), balanceNote].filter(Boolean).join(' '));
      input.addEventListener('input', () => { rows[r][c] = input.value; invalidateReview(); });
      td.append(input);
    });
  });
  $('row-number').max = rows.length;
  $('column-number').max = rows[0].length;
  $('add-row').disabled = rows.length >= rowLimit();
  $('remove-row').disabled = rows.length <= 1;
  $('add-column').disabled = rows[0].length >= 20;
  $('remove-column').disabled = rows[0].length <= 1;
}
function setRows(value, realigned = []) {
  if (!Array.isArray(value) || !value.length || value.length > rowLimit() ||
      !Array.isArray(value[0]) || !value[0].length || value[0].length > 20 ||
      value.some(row => !Array.isArray(row) || row.length !== value[0].length || row.some(cell => typeof cell !== 'string' || cell.length > 2000))) {
    throw new Error(draftPDF ? 'The reader returned an incomplete statement. Try downloading a fresh copy.' : 'The reader returned an incomplete table. Try a clearer image.');
  }
  rows = value.map(row => [...row]);
  realignedCells = new Set(realigned.filter(cell => cell && Number.isInteger(cell.row) && Number.isInteger(cell.column) &&
    cell.row >= 1 && cell.row <= rows.length && cell.column >= 1 && cell.column <= rows[0].length)
    .map(cell => `${cell.row},${cell.column}`));
  $('alignment-hint').textContent = 'Some text was aligned using its position across neighbouring columns. Check the marked cells carefully against the image.';
  $('alignment-hint').hidden = realignedCells.size === 0;
  $('row-number').value = $('column-number').value = '1';
  invalidateReview();
}
for (const axis of ['row', 'column']) for (const action of ['add', 'remove']) {
  $(`${action}-${axis}`).addEventListener('click', () => {
    const control = $(`${axis}-number`), count = axis === 'row' ? rows.length : rows[0].length;
    const index = Number(control.value) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      $('structure-status').textContent = `Enter a ${axis} number from 1 to ${count}.`; control.focus(); return;
    }
    if ((action === 'remove' && count <= 1) || (action === 'add' && count >= (axis === 'row' ? rowLimit() : 20))) return;
    if (axis === 'row') {
      if (action === 'add') rows.splice(index + 1, 0, rows[0].map(() => ''));
      else rows.splice(index, 1);
    } else for (const row of rows) {
      if (action === 'add') row.splice(index + 1, 0, '');
      else row.splice(index, 1);
    }
    control.value = String(Math.min(index + 1, action === 'remove' ? count - 1 : count));
    if (realignedCells.size) {
      realignedCells.clear();
      $('alignment-hint').textContent = 'The table structure has changed. Check all cell positions against the image.';
    }
    if (draftPDF) {
      balanceRows.clear();
      $('balance-hint').textContent = 'The rows have changed since reading, so the balance markers are cleared. Check the balances against the pages.';
    }
    invalidateReview(); renderGrid();
    $('structure-status').textContent = `${axis === 'row' ? 'Row' : 'Column'} ${action === 'add' ? 'added' : 'removed'}. Check the table again before saving.`;
    control.focus();
  });
}
$('reviewed').addEventListener('change', () => {
  $('save').disabled = !($('reviewed').checked && rows.some(row => row.some(cell => cell.trim())));
  $('review-confirmed').hidden = $('save').disabled;
});
function csvFilename(sourceName) {
  // Name the CSV after the chosen image, keeping only characters that are safe in every file system.
  const stem = String(sourceName || '').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]+/gu, ' ').trim().slice(0, 100);
  return (stem || 'table') + '.csv';
}
function csvCell(value) {
  // Quoting alone does not stop spreadsheet applications interpreting formulas.
  const negativeNumber = /^-[£€$]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value);
  if ((!negativeNumber && /^[\s]*[=+@-]/.test(value)) || /^[\t\r\n]/.test(value)) value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
}
$('save').addEventListener('click', async () => {
  if ($('save').disabled || saving) return;
  const snapshot = JSON.stringify(rows);
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  if (window.__TAURI__?.core?.invoke) {
    $('save').disabled = true;
    saving = true; publishSession();
    try {
      const saved = await window.__TAURI__.core.invoke('save_csv', {
        filename: csvFilename(picker.file?.name), content: csv,
      });
      if (saved) savedTable = snapshot;
      status(saved ? 'Table saved as CSV.' : 'Save cancelled. Your reviewed table is still here.');
    } catch {
      status('The CSV could not be saved. Check the destination and try again.');
    } finally {
      saving = false; publishSession();
      $('save').disabled = !($('reviewed').checked && rows.some(row => row.some(cell => cell.trim())));
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = csvFilename(picker.file?.name); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  savedTable = snapshot; publishSession();
  status('Table saved as CSV.');
});

function updateDescribe() {
  queueMicrotask(publishSession);
  if (preparationFile !== picker.file) {
    preparationFile = picker.file;
    turns = 0; resetCrop();
    $('preview').hidden = picker.pdf;
    $('prepare-image').hidden = picker.pdf;
    $('pdf-note').hidden = !picker.pdf;
    $('describe').textContent = picker.pdf ? 'Read this statement' : 'Read this table';
    $('crop-preview').hidden = true;
    $('crop-preview').width = $('crop-preview').height = 1;
    $('crop-source').width = $('crop-source').height = 1;
    cropDrag = null;
    $('crop-status').textContent = '';
    $('prepare-image').open = false;
  }
  $('describe').disabled = !ready || !picker.file || !picker.ready || !validCrop() || Boolean(active);
}

const picker = createImagePicker({ fileError, busy: () => Boolean(active) || saving, changed: updateDescribe,
  clearResult, status, selectionReady: () => status(ready ? 'Ready when you are.' : 'The local reader needs setting up. See README.md.') });

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!picker.file || !picker.ready || !ready || !validCrop() || active) return;
  fileError.clear();
  clearResult();
  const job = { id: crypto.randomUUID(), controller: new AbortController() };
  active = job;
  activity.start();
  $('add').hidden = true;
  $('wait').hidden = false;
  $('wait-title').focus();
  $('image').disabled = $('describe').disabled = true;
  status('Reading your table on this device.');
  let reserved = false;
  try {
    if (hosted) {
      try { await window.__TAURI__.core.invoke('begin_job'); reserved = true; }
      catch { throw new Error('Another Cup is working. Return to Kettle and stop or finish that job first.'); }
    }
    const input = await preparedInput();
    if (job.controller.signal.aborted) return;
    const response = await fetch(`/api/extract/${job.id}`, {
      method: 'POST', headers: { 'X-Kettle-Cup': '1', 'Content-Type': input.type },
      body: input, signal: job.controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'The table could not be read.'), { code: result.code });
    if (job.controller.signal.aborted) return;
    showDraftKind(result.input === 'pdf');
    setRows(result.rows, Array.isArray(result.realigned_cells) ? result.realigned_cells : []);
    if (draftPDF) {
      showPages(result.pages);
      showBalance(Array.isArray(result.balance_breaks) ? result.balance_breaks : [], result.balance_steps);
    } else {
      resultImageURL = URL.createObjectURL(input);
      $('table-preview').src = resultImageURL;
      $('open-original').href = $('preview').src;
    }
    renderGrid();
    $('result').hidden = false;
    $('result-title').focus();
    status('Your draft is ready. Check it before using it.');
  } catch (error) {
    if (imageErrors.has(error.code)) {
      status('');
      fileError.show(error.message, { moveFocus: false });
    } else if (error.name === 'AbortError') status('Stopped. Nothing was saved.');
    else {
      status('');
      $('read-error-message').textContent = error.message;
      $('read-error').hidden = false;
    }
  } finally {
    if (reserved) {
      try { await window.__TAURI__.core.invoke('end_job'); }
      catch { status('The worker has not confirmed it stopped. Quit and reopen Kettle before another model job.'); }
    }
    activity.stop();
    active = null;
    $('wait').hidden = true;
    $('add').hidden = !$('result').hidden;
    $('image').disabled = false;
    updateDescribe();
    if (fileError.active) fileError.focus();
    else if (!$('read-error').hidden) $('read-error').focus();
    else if ($('result').hidden) $('add-title').focus();
  }
});

$('stop').addEventListener('click', async () => {
  const job = active;
  if (!job) return;
  job.controller.abort();
  try { await fetch(`/api/cancel/${job.id}`, { method: 'POST', headers: { 'X-Kettle-Cup': '1' } }); } catch { /* Aborted connection also stops the worker. */ }
});
window.addEventListener('pagehide', () => {
  active?.controller.abort();
  if (resultImageURL) URL.revokeObjectURL(resultImageURL);
  for (const url of pageURLs) URL.revokeObjectURL(url);
});
try {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error();
  const result = await response.json();
  ready = result.ready;
  updateDescribe();
  status(ready ? 'Ready when you are.' : result.error);
} catch { status('The local reader is unavailable. Start this cup using the instructions in README.md.'); }

if (hosted) {
  $('return-kettle').hidden = false;
  const back = () => window.__TAURI__.core.invoke('show_chooser').catch(() => status('Kettle could not open. Your work is still here.'));
  $('return-kettle').addEventListener('click', back);
  document.querySelector('.wordmark').addEventListener('click', event => { event.preventDefault(); back(); });
}
window.addEventListener('beforeunload', event => {
  if (hasUnsavedWork()) { event.preventDefault(); event.returnValue = ''; }
});
