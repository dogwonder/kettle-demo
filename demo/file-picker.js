// Stands in for a Cup's file-picker.js inside a demo. The binding is the one
// every Cup calls (ui-patterns/file-picker), but Choose opens a prepared sample
// and a dropped file is turned away, so nothing of the visitor's is ever read.
const cup = location.pathname.split('/')[2];
const demo = fetch(`/demo/${cup}/demo.json`).then((found) => found.json());

async function filesOf(sample) {
  return Promise.all(sample.files.map(async ({ name, type }) => {
    const found = await fetch(`/demo/${cup}/samples/${encodeURIComponent(name)}`);
    if (!found.ok) throw new Error(`The sample ${name} is missing from this demo.`);
    return new File([await found.blob()], name, { type });
  }));
}

export function bindFilePicker({ buttons, zone, accept, busy = () => false }) {
  const note = Object.assign(document.createElement('p'), { className: 'small' });
  const list = Object.assign(document.createElement('p'), { className: 'button-row', hidden: true });
  const choose = async (name) => {
    const { samples = [] } = await demo;
    const sample = samples.find((known) => known.name === name) ?? samples[0];
    if (!sample || busy()) return;
    list.hidden = true;
    await accept(await filesOf(sample)); // a Cup's own handler may still be reading the file
  };
  // The strip above the page opens a sample through this, as a visitor's click does.
  window.__kttlDemo = { choose };

  demo.then(({ samples = [] }) => {
    if (!samples.length) return;
    note.textContent = samples.length === 1
      ? `This demo opens a prepared sample, ${samples[0].label}. It cannot open a file of yours.`
      : 'This demo opens prepared samples. It cannot open a file of yours.';
    list.replaceChildren(...samples.map((sample) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'govuk-button govuk-button--secondary', textContent: sample.label });
      button.addEventListener('click', () => choose(sample.name));
      return button;
    }));
    zone.append(note, list);
    for (const button of buttons) button.addEventListener('click', () => {
      if (busy()) return;
      if (samples.length === 1) choose(samples[0].name);
      else list.hidden = !list.hidden;
    });
  });

  for (const name of ['dragenter', 'dragover', 'drop']) window.addEventListener(name, (event) => {
    event.preventDefault();
    if (name === 'drop') note.textContent = 'This demo cannot open a file of yours. Use a prepared sample.';
  });
}
