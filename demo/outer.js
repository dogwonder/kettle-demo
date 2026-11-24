// The demo's own page: a strip above the Cup's page, which sits in a frame as
// it sits in the app's window. This starts the replay worker, loads the page,
// and runs a prepared example by doing in the page what a visitor would do.
const demo = JSON.parse(document.getElementById('demo-data').textContent);
const frame = document.getElementById('demo-frame');
const said = document.getElementById('demo-said');
const app = `/demo/${demo.cup}/app/`;
const say = (words) => { said.textContent = words; };

const shown = (element) => Boolean(element) && !element.closest('[hidden]') && element.getClientRects().length > 0;
async function until(selector, wanted = shown, limit = 20000) {
  const end = Date.now() + limit;
  for (;;) {
    const element = frame.contentDocument?.querySelector(selector);
    if (wanted(element)) return element;
    if (Date.now() > end) throw new Error(`The demo page did not show ${selector}.`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}
const present = (element) => Boolean(element);

function loaded() {
  return new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
}

// The same few steps the capture command performs in a real browser against the real worker.
async function run(steps) {
  for (const step of steps) {
    if (step.sample) {
      await until('body', () => Boolean(frame.contentWindow.__kttlDemo));
      await frame.contentWindow.__kttlDemo.choose(step.sample);
    } else if (step.fill) {
      const field = await until(step.fill, present);
      field.value = step.value;
      for (const name of ['input', 'change']) field.dispatchEvent(new Event(name, { bubbles: true }));
    } else if (step.select) {
      const field = await until(step.select, present);
      field.value = step.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (step.check) {
      const field = await until(step.check, present);
      if (!field.checked) field.click();
    } else if (step.click) {
      (await until(step.click)).click();
    } else if (step.wait) {
      await until(step.wait);
    }
  }
}

// The page's wordmark leads to "/", which in the app is the page itself. Here "/" is the site's home
// page, so the whole window goes there, not the frame.
frame.addEventListener('load', () => {
  const inside = frame.contentWindow;
  if (inside.location.pathname === '/') { location.assign('/'); return; }
  if (!inside.location.pathname.startsWith(app)) { inside.location.replace(app); return; }
  // What only the app can do, such as showing a file in Finder, is not offered here.
  if (demo.leftOut?.length) {
    const hide = inside.document.createElement('style');
    hide.textContent = `${demo.leftOut.join(', ')} { display: none !important; }`;
    inside.document.head.append(hide);
  }
  inside.document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (link && new URL(link.href).pathname === '/') { event.preventDefault(); location.assign('/'); }
  }, true);
});

let running = false;
async function example(preset) {
  if (running) return;
  running = true;
  say(`Showing: ${preset.label}`);
  try {
    const ready = loaded();
    frame.contentWindow.location.replace(app);
    await ready;
    await until(demo.ready);
    await run(preset.steps);
    (await until(preset.until)).scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (said.textContent.startsWith('Showing')) say('');
  } catch (problem) {
    say(problem.message);
  } finally {
    running = false;
  }
}

async function start() {
  if (!('serviceWorker' in navigator)) throw new Error('unsupported');
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data.type === 'miss') say('That is not one of the prepared examples, so this demo has no answer for it. Try one of the examples.');
    else if (data.type === 'replayed' && data.ms >= 1000) say(`Replayed from a recording. When it was recorded, this step took ${(data.ms / 1000).toFixed(1)} seconds on a Mac.`);
  });
  await navigator.serviceWorker.register('/demo/sw.js', { scope: '/demo/' });
  await navigator.serviceWorker.ready;
  const ready = loaded();
  frame.src = app;
  await ready;
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.addEventListener('click', () => example(demo.presets[Number(button.dataset.preset)]));
  }
  document.getElementById('demo-try')?.removeAttribute('hidden');
}

start().catch(() => {
  document.getElementById('demo-unavailable').hidden = false;
  frame.hidden = true;
});
