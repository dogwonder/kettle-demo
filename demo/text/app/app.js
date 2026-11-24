import { run, compareLists } from './text-ops.js';
import { bindFilePicker } from './file-picker.js';
const $ = id => document.getElementById(id);
const form = $('form');
let sourceName = null, previous = null, shown = null, compared = false, kept = false;
// Inside the Kettle desktop app: tell it when closing would lose text, and save natively.
const invoke = window.__TAURI__?.core?.invoke;
const hosted = new URLSearchParams(location.search).get('kettle') === '1' && Boolean(invoke);
function status(message) { $('status').textContent = message; }
function unsaved() { return Boolean($('input').value) && !kept; }
function publishSession() {
  if (hosted) invoke('cup_state', { dirty: unsaved(), busy: false })
    .catch(() => status('Kettle could not track this session. Keep the window open and copy or save your text.'));
}
function changed() { kept = false; publishSession(); }
function keep() { kept = true; publishSession(); }
function error(message, field = $('error')) {
  for (const element of [$('error'), $('operation-error')]) { element.textContent = ''; element.hidden = true; }
  if (!message) return;
  field.textContent = message; field.hidden = false;
  if (field === $('error')) field.focus(); else $('op-sort').focus();
}
function hideResult(message) {
  if (shown === null && !compared) return;
  shown = null; compared = false; $('result').hidden = true; $('comparison').hidden = true; status(message);
}
function showOptions() {
  const chosen = form.elements.operation.value;
  for (const group of document.querySelectorAll('[data-options]')) group.hidden = group.dataset.options !== chosen;
  $('apply').textContent = chosen === 'compare' ? 'Compare the two lists' : 'Make this change';
}
function item(list, text) { const entry = document.createElement('li'); entry.textContent = text; list.append(entry); }
function make(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
const number = count => count.toLocaleString('en-GB');
const plural = (count, one, many = `${one}s`) => `${number(count)} ${count === 1 ? one : many}`;
// A comparison changes nothing, so there is no result to replace the text with: three lists to read and copy.
function showComparison(found) {
  $('counted').replaceChildren(); $('groups').replaceChildren();
  for (const [name, side] of [['Your text', found.first], ['The second list', found.second]]) {
    item($('counted'), `${name}: ${plural(side.lines, 'line')}, ${plural(side.items, 'different item')}`
      + `${side.repeated ? `, ${number(side.repeated)} of them written more than once` : ''}${side.blank ? `. ${plural(side.blank, 'blank line')} left out` : ''}.`);
  }
  $('nearly').textContent = found.nearly ? `${plural(found.nearly, 'item')} in one list only ${found.nearly === 1 ? 'is' : 'are'} in the other apart from capitals or spaces at the ends. Tick the choices under “Count as the same item” to count them as the same.` : '';
  $('nearly').hidden = !found.nearly;
  const groups = [
    ['both', 'In both lists', found.both, ['first', 'second']],
    ['only-first', 'Only in your text', found.onlyFirst, ['first']],
    ['only-second', 'Only in the second list', found.onlySecond, ['second']],
  ];
  for (const [id, title, entries, sides] of groups) {
    const block = make('div', '', 'screen'); block.id = id;
    block.append(make('h3', `${title}: ${number(entries.length)}`));
    if (entries.length) {
      const table = make('table', '', 'govuk-table'), caption = table.createCaption(), head = table.createTHead().insertRow(), body = table.createTBody();
      caption.textContent = title; caption.className = 'govuk-visually-hidden'; head.className = 'govuk-table__row';
      for (const [index, label] of ['Item', ...sides.map(side => side === 'first' ? 'Times in your text' : 'Times in the second list')].entries()) {
        const cell = make('th', label, `govuk-table__header${index ? ' govuk-table__header--numeric' : ''}`); cell.scope = 'col'; head.append(cell);
      }
      for (const entry of entries) {
        const row = body.insertRow(), name = make('td', '', 'govuk-table__cell');
        row.className = 'govuk-table__row';
        name.append(make('span', entry.item, 'compared-item'));
        if (entry.written.length) name.append(make('span', `Also written: ${entry.written.slice(1).map(text => `“${text}”`).join(', ')}`, 'small compared-also'));
        row.append(name, ...sides.map(side => make('td', number(entry[side]), 'govuk-table__cell govuk-table__cell--numeric')));
      }
      const copy = make('button', `Copy these ${plural(entries.length, 'item')}`, 'govuk-button govuk-button--secondary'); copy.type = 'button';
      copy.addEventListener('click', async () => {
        const text = entries.map(entry => entry.item).join('\n');
        try { await navigator.clipboard.writeText(text); status(`${title}: ${plural(entries.length, 'item')} copied, one on each line.`); }
        catch { status('Copying was not allowed. Select the items in the table and copy them with the keyboard.'); }
      });
      const row = make('div', '', 'button-row'); row.append(copy);
      block.append(table, row);
    } else block.append(make('p', 'None.'));
    $('groups').append(block);
  }
  compared = true; $('comparison').hidden = false; $('comparison-title').focus();
  status('Compared. Neither list was changed.');
}
function show(result) {
  $('changes').replaceChildren(); $('lists').replaceChildren();
  for (const change of result.changes) item($('changes'), `${change.what}: ${change.count.toLocaleString('en-GB')}`);
  if (!result.changes.length) item($('changes'), 'Nothing needed changing. The result is identical to your text.');
  for (const list of result.lists || []) {
    const label = document.createElement('p'); label.textContent = `${list.label} (${list.items.length.toLocaleString('en-GB')}):`;
    const words = document.createElement('ul'); words.className = 'undecided';
    for (const word of list.items) item(words, word);
    $('lists').append(label, words);
  }
  $('note').textContent = result.note || ''; $('note').hidden = !result.note;
  $('output').value = result.text; shown = result.text;
  $('result').hidden = false; $('result-title').focus();
  status(result.changes.length ? 'Done. Check what changed before you copy or save.' : 'Nothing needed changing.');
}
form.addEventListener('change', event => { if (event.target.name === 'operation') showOptions(); error(''); hideResult('You changed the choice. Make the change again to see the new result.'); });
$('input').addEventListener('input', () => { changed(); hideResult('Your text changed. Make the change again to see the new result.'); });
$('second').addEventListener('input', () => hideResult('The second list changed. Compare again to see the new result.'));
form.addEventListener('submit', event => {
  event.preventDefault();
  const choice = form.elements;
  if (!choice.operation.value) return error('Choose one change.', $('operation-error'));
  if (!$('input').value) return error('Paste or open some text first.');
  if (choice.operation.value === 'compare') {
    if (!$('second').value.trim()) return error('Paste the second list first.');
    error(''); hideResult('');
    return showComparison(compareLists($('input').value, $('second').value, { ignoreCase: choice.ignoreCase.checked, trimEnds: choice.trimEnds.checked }));
  }
  error(''); hideResult('');
  try {
    show(run(choice.operation.value, $('input').value, { order: choice.order.value, to: choice.to.value, mode: choice.mode.value, lineStarts: choice.lineStarts.checked }));
    changed();
  } catch { error('This change could not be made. Your text is still here, unchanged.'); }
});
async function openFile(files) {
  error('');
  if (files.length !== 1) return error('Choose one text file at a time. Your text is still here.');
  const [file] = files;
  if (!file.size || file.size > 5 * 1024 * 1024) return error('Choose a plain text file up to 5 MB. Your text is still here.');
  let text;
  try { text = await file.text(); } catch { return error('This file could not be read. Your text is still here.'); }
  if (text.includes('\0')) return error('This does not look like plain text. Save it as a .txt file first. Your text is still here.');
  if ($('input').value && !window.confirm('Replace the text that is here with this file? Nothing is saved for you.')) return;
  $('input').value = text; sourceName = file.name; previous = null; $('restore').hidden = true;
  hideResult(''); $('input').focus(); keep(); // The file itself is still on disk.
  status(text.includes('\uFFFD') ? `${file.name} opened, but some characters are not UTF-8 and show as \uFFFD. Save the file as UTF-8 and open it again to keep them.` : `${file.name} opened. The file itself is never changed.`);
}
bindFilePicker({ input: $('file'), buttons: [$('choose-file')], zone: $('picker'), accept: openFile });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shown); status('Result copied.'); keep(); }
  catch { $('output').focus(); $('output').select(); status('Copying was not allowed. The result is selected: copy it with the keyboard.'); }
});
$('save').addEventListener('click', async () => {
  const [, stem, extension] = /^(.*?)(\.[^.]+)?$/.exec(sourceName || 'text');
  const filename = `${stem}-changed${extension || '.txt'}`;
  if (hosted) {
    try {
      if (!await invoke('save_text_result', { filename, content: shown })) return status('Not saved. The result is still here.');
      keep(); return status('Result saved where you chose.');
    } catch { return error('The result could not be saved. It is still here: try another place, or copy it.'); }
  }
  const url = URL.createObjectURL(new Blob([shown], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Result sent to your browser’s downloads as a new file. Check it before closing.');
  keep();
});
$('replace').addEventListener('click', () => {
  previous = $('input').value; $('input').value = shown;
  hideResult('The result is now your text. You can make another change, or put the earlier text back.'); changed();
  $('restore').hidden = false; $('input').focus();
});
$('restore').addEventListener('click', () => {
  if (previous === null) return;
  $('input').value = previous; previous = null; $('restore').hidden = true;
  hideResult(''); status('The earlier text is back.'); $('input').focus(); changed();
});
showOptions();
if (hosted) {
  $('return-kettle').hidden = false;
  const back = () => invoke('show_chooser').catch(() => status('Kettle could not open. Your text is still here.'));
  $('return-kettle').addEventListener('click', back);
  document.querySelector('.wordmark')?.addEventListener('click', event => { event.preventDefault(); back(); });
}
