// Kettle file-picker pattern v1. Maintained in ui-patterns/file-picker/.
// Vendored into each Cup; no parent/sibling build or runtime dependency.
// Derived from Tables a6d463f and Meeting Notes' 14 September 2026 drop zone.
export function bindFilePicker({ input, buttons, zone, accept, busy = () => false }) {
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = ''; // Choosing the same file again must still fire change.
    if (!busy() && files.length) accept(files);
  });
  for (const button of buttons) button.addEventListener('click', () => {
    if (!busy()) input.click();
  });
  for (const name of ['dragenter', 'dragover']) zone.addEventListener(name, event => {
    event.preventDefault();
    if (!busy() && event.dataTransfer?.types.includes('Files')) {
      event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dragging');
    } else {
      zone.classList.remove('dragging');
    }
  });
  zone.addEventListener('dragleave', event => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('dragging');
  });
  zone.addEventListener('drop', event => {
    event.preventDefault();
    zone.classList.remove('dragging');
    if (!busy() && event.dataTransfer?.files.length) accept([...event.dataTransfer.files]);
  });
  // A missed drop must not navigate away from local work.
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());
}
