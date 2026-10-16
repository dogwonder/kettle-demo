import { bindFilePicker } from './file-picker.js';
// Tables-owned presentation helpers; task requests and CSV export live in app.js.
export function createFileError({ group, focusTarget }) {
  const error = group.querySelector('[data-field-error]');
  const message = error.querySelector('[data-error-message]');
  const descriptions = new Map();
  function associate(control) {
    if (!control) return;
    if (!descriptions.has(control)) descriptions.set(control, control.getAttribute('aria-describedby'));
    const ids = new Set((descriptions.get(control) || '').split(/\s+/).filter(Boolean));
    ids.add(error.id);
    control.setAttribute('aria-describedby', [...ids].join(' '));
    if (control.hasAttribute('data-file-control')) control.setAttribute('aria-invalid', 'true');
  }
  function clear() {
    group.classList.remove('govuk-form-group--error');
    error.hidden = true;
    message.textContent = '';
    for (const [control, original] of descriptions) {
      if (original === null) control.removeAttribute('aria-describedby');
      else control.setAttribute('aria-describedby', original);
      control.removeAttribute('aria-invalid');
    }
    descriptions.clear();
  }
  function focus() {
    const control = focusTarget();
    associate(control);
    control?.focus();
  }
  return {
    clear,
    focus,
    get active() { return !error.hidden; },
    show(text, { moveFocus = true } = {}) {
      clear();
      message.textContent = text;
      group.classList.add('govuk-form-group--error');
      error.hidden = false;
      for (const control of group.querySelectorAll('[data-file-control]')) associate(control);
      if (moveFocus) focus();
    },
  };
}

export function createActivity({ elapsed = document.getElementById('elapsed') } = {}) {
  let timer;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    document.body.removeAttribute('data-running');
  };
  window.addEventListener('pagehide', stop);
  return {
    start() {
      stop();
      document.body.setAttribute('data-running', '');
      const started = Date.now();
      const tick = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} elapsed`;
      };
      tick();
      timer = setInterval(tick, 1000);
    },
    stop,
  };
}


// One-file selection and preview for Tables: a table image, or a PDF statement
// (no preview or crop; the reader returns rendered pages with the draft).
export function createImagePicker({ fileError, busy, changed, clearResult, status, selectionReady }) {
  const $ = id => document.getElementById(id);
  let selected = null, previewURL = null, previewReady = false;
function resetSelection() {
  fileError.clear();
  clearResult();
  selected = null;
  previewReady = false;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  $('preview').onload = $('preview').onerror = null;
  $('preview').removeAttribute('src');
  $('filename').textContent = '';
  $('image').value = '';
  $('empty-image').hidden = false;
  $('image-selection').hidden = $('read-actions').hidden = true;
  changed();
}

function selectImages(files) {
  if (busy()) return;
  files = [...files];
  if (!files.length) return;
  resetSelection();
  status('');
  let problem;
  const file = files[0], pdf = file.type === 'application/pdf';
  if (files.length !== 1) problem = 'Choose one file at a time.';
  else if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) problem = 'Choose a JPEG, PNG or WebP image, or a PDF statement.';
  else if (!file.size) problem = pdf ? 'This PDF is empty. Try downloading a fresh copy.' : 'This image is empty. Try exporting a fresh copy.';
  else if (file.size > 15 * 1024 * 1024) problem = pdf ? 'This PDF exceeds 15 MB. Choose one statement at a time.' : 'This photograph exceeds 15 MB. Choose a smaller copy.';
  if (problem) { fileError.show(problem); return; }
  selected = file;
  const show = () => {
    previewReady = true;
    $('empty-image').hidden = true;
    $('image-selection').hidden = $('read-actions').hidden = false;
    changed();
    selectionReady();
    $('change-image').focus();
  };
  if (pdf) {
    // The browser cannot show a PDF in an image; the reader renders its pages.
    $('filename').textContent = file.name;
    show();
    return;
  }
  const refuse = message => {
    resetSelection();
    status('');
    fileError.show(message);
  };
  $('preview').onload = () => {
    if (file !== selected) return;
    if ($('preview').naturalWidth * $('preview').naturalHeight > 25_000_000) {
      refuse('This photograph exceeds 25 million pixels. Choose a smaller copy.');
      return;
    }
    show();
  };
  $('preview').onerror = () => {
    if (file !== selected) return;
    refuse("This image couldn't be opened. Try exporting a fresh copy.");
  };
  previewURL = URL.createObjectURL(file);
  $('preview').src = previewURL;
  $('filename').textContent = file.name;
  status('Opening your photograph…');
}

function removeImage() {
  if (busy()) return;
  resetSelection();
  status('Choose another file.');
  $('choose').focus();
}

bindFilePicker({ input: $('image'), buttons: [$('choose'), $('change-image')],
  zone: $('form'), accept: selectImages, busy });
$('remove-image').addEventListener('click', removeImage);
$('clear').addEventListener('click', removeImage);

  window.addEventListener('pagehide', () => { if (previewURL) URL.revokeObjectURL(previewURL); });
  return { reset: resetSelection, get file() { return selected; }, get ready() { return previewReady; },
    get pdf() { return selected?.type === 'application/pdf'; } };
}
