// Text's five exact operations: the one task source for the browser UI, text.mjs
// and the tests. Pure functions of their input: no DOM, network, storage, clock
// or model. Every operation returns { text, changes: [{ what, count }] } and,
// where the person has something to check, lists: [{ label, items }] or a note.
// Windows and old Mac line endings always become plain line breaks, and are counted.
// compareLists, at the end, is not an operation: it changes nothing and has its own result.

const SPACE = '[ \\t\\u00A0]';
const SYMBOL_BULLETS = '•◦▪‣⁃●○■□\\uF0B7\\uF0A7'; // includes Word's private-use Symbol bullets
const ROMAN = { i: 1, v: 5, x: 10 };
// A list marker at the start of a line, after any indentation, with the space after it.
// Hyphens, asterisks and dashes need a following space, so -5, *bold* and --flag are left alone.
// "a." and "I." are not markers: they are too often initials.
const MARKER = new RegExp(`^([ \\t]*)(?:[${SYMBOL_BULLETS}]${SPACE}*|[-*–—·]${SPACE}+|(?:\\d{1,3}[.)]|\\(\\d{1,3}\\)|[A-Za-z]\\)|\\([A-Za-z]\\)|[ivxIVX]{1,6}\\)|\\([ivxIVX]{1,6}\\))(?:${SPACE}+|$))`);
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu;
// Never treated as the end of a sentence when choosing capitals. "etc." and "no." are left out: they often are one.
const ABBREVIATION = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|prof|vs|e\.g|i\.e)$/iu;
// One sentence per line is more cautious: a missed break is easier to see and mend than a wrong one.
const NO_BREAK_AFTER = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|prof|st|mt|jr|sr|no|nos|fig|figs|approx|inc|ltd|co|ca|cf|p|pp|vol|ed|eds|est|vs|e\.g|i\.e)$/iu;
// English always capitalises these. "march", "may", "sat" and "sun" are also ordinary words, so they are not here.
const ALWAYS_CAPITAL = new Set(`january february april june july august september october november december
monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/));
const CONTRACTION = /^(?:do|does|did|is|are|was|were|has|have|had|could|should|would|ca|wo)n't$/;
const INITIAL = /(?:^|[^\p{L}])\p{Lu}$/u;
const SMALL = new Set('a an and as at but by for from in into nor of on or the to with'.split(' '));
// Words that are ordinary in any sentence; everything else lowered from capitals is left to the person.
const COMMON = new Set(`a about above across after again against all almost alone along already also although always am among an and
another any anyone anything are area around as ask asked at away back be became because become been before began behind being below
best better between big both bring but by call called came can cannot case change child children come could country day days did
different do does done down during each early either end enough even ever every example eye face fact family far feel felt few find
first five for form found four from full gave get give given go going gone good got great group had half hand hard has have he head
help her here high him his home house how however i if important in into is it its just keep kept kind knew know known large last
later least left less let life like line little long look looked made make man many may me mean men might more most much must my name
near need never new next night no not nothing now number of off often old on once one only open or order other others our out over
own page part people per perhaps place point put quite rather read really right room said same saw say says school second see seem
seemed seen set several shall she should show side since small so some something sometimes soon still such take taken tell than that
the their them then there these they thing things think this those though thought three through time times to today together told
too took toward turn turned two under until up upon us use used using very want was water way ways we week well went were what when
where whether which while who whole whose why will with within without word words work world would write year years yes yet you
young your please thank thanks dear regards sincerely meeting report project team email date note notes item items list text section
total amount price cost paid order address phone telephone number details information form see below above following attached`.split(/\s+/));

function open(text) {
  const endings = (text.match(/\r\n|\r/g) || []).length;
  const unix = endings ? text.replace(/\r\n|\r/g, '\n') : text;
  const final = unix.endsWith('\n');
  const body = final ? unix.slice(0, -1) : unix;
  return { lines: body === '' ? [] : body.split('\n'), final, endings };
}

function close(lines, { final, endings }, changes, extra = {}) {
  if (endings) changes.push({ what: 'Windows or old Mac line endings changed to plain line breaks', count: endings });
  return { text: lines.join('\n') + (final ? '\n' : ''), changes: changes.filter(change => change.count), ...extra };
}

// 1. Reorders whole lines. Never changes a line's characters.
export function sortLines(text, { order = 'az', locale = 'en-GB' } = {}) {
  const source = open(text);
  const collator = new Intl.Collator(locale);
  const sign = order === 'za' ? -1 : 1;
  const blank = source.lines.filter(line => !line.trim());
  const sorted = source.lines.filter(line => line.trim())
    .sort((a, b) => sign * collator.compare(a.trimStart(), b.trimStart())); // stable: equal lines keep their order
  const result = [...sorted, ...blank];
  const moved = result.filter((line, index) => line !== source.lines[index]).length;
  const early = source.lines.slice(0, sorted.length).filter(line => !line.trim()).length;
  return close(result, source, [
    { what: 'Lines now in a different position', count: moved },
    { what: 'Blank lines moved to the end', count: early },
  ]);
}

// 2. Removes list markers at the start of lines. Numbers and symbols elsewhere are untouched.
export function removeListMarkers(text) {
  const source = open(text);
  let markers = 0, changed = 0;
  const result = source.lines.map(line => {
    let rest = line, match, touched = false;
    // Repeat so "- 1. item" is finished in one pass and a second pass changes nothing.
    while ((match = MARKER.exec(rest)) && match[0].length > match[1].length) {
      rest = match[1] + rest.slice(match[0].length);
      markers++; touched = true;
    }
    if (touched) changed++;
    return rest;
  });
  return close(result, source, [
    { what: 'List markers removed', count: markers },
    { what: 'Lines changed', count: changed },
  ]);
}

// Works from the original first letter, so İ stays one character instead of becoming I plus a dot.
const capitalise = word => { const [first = '', ...rest] = word; return first.toUpperCase() + rest.join('').toLowerCase(); };

// 3. lower, upper, title or sentence. Only the case of letters changes.
export function changeCase(text, { to = 'sentence' } = {}) {
  const source = open(text);
  const body = source.lines.join('\n');
  const mixed = /\p{Ll}/u.test(body);
  const undecided = new Set();
  let changed = 0, last = 0;
  const converted = body.replace(WORD, (word, offset) => {
    const gap = body.slice(last, offset);
    const before = body.slice(Math.max(0, last - 6), last);
    last = offset + word.length;
    const lower = word.toLowerCase();
    let next;
    if (to === 'lower') next = lower;
    else if (to === 'upper') next = word.toUpperCase();
    else {
      const stop = to === 'title' ? /[.!?:…]/ : /[.!?…]/;
      const start = offset === gap.length || gap.includes('\n')
        || (new RegExp(`^["'”’)\\]]*${stop.source}["'”’)\\]]*\\s`).test(gap) && !(gap[0] === '.' && ABBREVIATION.test(before)));
      // In text that already has lower case, inner capitals mean an acronym or a name like McKay: keep it.
      if (mixed && /\p{Lu}/u.test(word.slice(1))) next = word;
      else if (to === 'title') next = !start && SMALL.has(lower) ? lower : capitalise(word);
      else if (start || ALWAYS_CAPITAL.has(lower) || /^i(?:['’](?:m|ll|ve|d))?$/.test(lower)) next = capitalise(word);
      else {
        next = lower;
        // Not worth the person's time: single letters, common words, and their contractions and possessives.
        const plain = lower.replace(/’/g, "'");
        const ordinary = [...plain].length < 2 || COMMON.has(plain) || CONTRACTION.test(plain) || COMMON.has(plain.replace(/'(?:s|re|ve|ll|d)$/, ''));
        if (word !== lower && !ordinary) undecided.add(lower);
      }
    }
    if (next !== word) changed++;
    return next;
  });
  const extra = {};
  if (undecided.size) extra.lists = [{ label: 'Now lower case, but could be names or acronyms. Code cannot tell; check these yourself', items: [...undecided] }];
  if (to === 'title' && !mixed && changed) extra.note = 'The text had no lower case, so acronyms could not be told from ordinary words. Check them yourself.';
  return close(converted === '' ? [] : converted.split('\n'), source, [{ what: 'Words whose capitals changed', count: changed }], extra);
}

const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };
const STRAY = [
  ['Soft hyphens removed', /\u00AD/g, ''],
  // A zero-width joiner inside an emoji sequence is part of the emoji and stays.
  ['Zero-width characters removed', /[\u200B\u200C\u200E\u200F\u2060\uFEFF]|\u200D(?!\p{Extended_Pictographic})/gu, ''],
  ['Replacement characters (\uFFFD) removed', /\uFFFD/g, ''],
  ['Form feeds and vertical tabs changed to line breaks', /[\f\v]/g, '\n'],
  ['Control characters removed', /[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, ''],
  ['Non-breaking and other unusual spaces changed to ordinary spaces', /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
  ['Ligatures changed to letters', /[\uFB00-\uFB06]/g, ligature => LIGATURES[ligature]],
];

// 4. Spacing and stray characters only. Letters, digits, punctuation and tabs are never changed.
export function tidy(text, { lineStarts = false } = {}) {
  const changes = [];
  let cleaned = text;
  for (const [what, pattern, replacement] of STRAY) {
    const count = (cleaned.match(pattern) || []).length;
    if (count) cleaned = cleaned.replace(pattern, replacement);
    changes.push({ what, count });
  }
  const source = open(cleaned);
  let ends = 0, starts = 0, runs = 0;
  const trimmed = source.lines.map(line => {
    let next = line.replace(/ +$/, '');
    if (next !== line) ends++;
    if (lineStarts && next.startsWith(' ')) { next = next.replace(/^ +/, ''); starts++; }
    return next.replace(/(?<=[^ ]) {2,}/g, () => { runs++; return ' '; });
  });
  // Blank lines: none at the start or end, and never more than one together.
  const end = trimmed.findLastIndex(line => line !== '');
  const kept = trimmed.filter((line, index) => line !== '' || (index > 0 && index < end && trimmed[index - 1] !== ''));
  changes.push({ what: 'Places where repeated spaces became one space', count: runs },
    { what: 'Lines with spaces removed from the end', count: ends },
    { what: 'Lines with spaces removed from the start', count: starts },
    { what: 'Extra blank lines removed', count: source.lines.length - kept.length });
  return close(kept, source, changes);
}

function romanValue(text) {
  const digits = [...text.toLowerCase()].map(letter => ROMAN[letter]);
  const value = digits.reduce((sum, digit, index) => sum + (digit < (digits[index + 1] || 0) ? -digit : digit), 0);
  return value;
}

// Inline numbering only counts when it runs 1, 2, 3 (or a, b, c; or i, ii, iii) on one line,
// so "see section 2. The next" is never split.
function sequenceBreaks(line) {
  const kinds = [
    [/(?<![^\s])(?:\((\d{1,3})\)|(\d{1,3})[.)])(?=[ \t])/g, Number],
    [/(?<![^\s])(?:\(([A-Za-z])\)|([A-Za-z])\))(?=[ \t])/g, letter => letter.toLowerCase().charCodeAt(0) - 96],
    [/(?<![^\s])(?:\(([ivxIVX]{1,6})\)|([ivxIVX]{1,6})\))(?=[ \t])/g, romanValue],
  ];
  const breaks = new Set();
  for (const [pattern, valueOf] of kinds) {
    let chain = [];
    const settle = () => { if (chain.length > 1) chain.forEach(token => breaks.add(token.index)); chain = []; };
    for (const match of line.matchAll(pattern)) {
      const token = { index: match.index, value: valueOf(match[1] ?? match[2]) };
      if (chain.length && token.value === chain.at(-1).value + 1) { chain.push(token); continue; }
      settle();
      if (token.value === 1 || !line.slice(0, token.index).trim()) chain = [token];
    }
    settle();
  }
  return breaks;
}

// 5. Line breaks only. Four exact rules; none decides where a paragraph of prose should start.
export function fixLineBreaks(text, { mode = 'rejoin' } = {}) {
  const source = open(text);
  const result = [];
  const changes = [];
  const extra = {};
  if (mode === 'rejoin') {
    // Blank lines and lines that start with a list marker keep their breaks; every other break goes.
    let joins = 0;
    const words = [];
    for (const line of source.lines) {
      const previous = result.at(-1);
      const marker = MARKER.exec(line);
      if (!line.trim() || previous === undefined || !previous.trim() || (marker && marker[0].length > marker[1].length)) { result.push(line); continue; }
      const head = previous.trimEnd(), tail = line.trim();
      joins++;
      if (/\p{L}[-\u2010\u00AD]$/u.test(head)) {
        // "exam-" + "ple" is one word. Before a capital or digit the hyphen is kept: "Anglo-" + "Saxon".
        const soft = head.endsWith('\u00AD');
        const whole = soft || /^\p{Ll}/u.test(tail);
        result[result.length - 1] = (whole ? head.slice(0, -1) : head) + tail;
        if (whole && !soft) words.push(head.slice(0, -1).match(/[\p{L}\p{N}'’-]+$/u)[0] + tail.match(/^[\p{L}\p{N}'’-]+/u)[0]);
      } else result[result.length - 1] = head + ' ' + tail;
    }
    changes.push({ what: 'Line breaks removed inside paragraphs', count: joins },
      { what: 'Words rejoined across a line-end hyphen', count: words.length });
    if (words.length) extra.lists = [{ label: 'Rejoined without their line-end hyphen. A word that should keep its hyphen, like well-being, needs putting back by hand', items: [...new Set(words)] }];
  } else {
    let added = 0;
    const bullets = new RegExp(`(?<=\\S)${SPACE}*(?=[${SYMBOL_BULLETS}])`, 'gu');
    const split = {
      markers: line => {
        const breaks = sequenceBreaks(line);
        let pieces = '', from = 0;
        for (const index of [...breaks].sort((a, b) => a - b)) {
          if (!line.slice(0, index).trim()) continue;
          pieces += line.slice(from, index).trimEnd() + '\n'; from = index;
        }
        return (pieces + line.slice(from)).replace(bullets, '\n');
      },
      // "end.Next": a lower-case letter, a full stop, then a capitalised word with no space.
      // Not inside a web address: the run of characters before the stop starts www. or contains ://.
      'sentence-ends': line => line.replace(/(?<=\p{Ll}[.!?]["”’)]?)(?=\p{Lu}\p{Ll})/gu, (match, offset) => {
        const run = line.slice(Math.max(0, offset - 200), offset).match(/\S*$/)[0];
        return /^www\.|:\/\//i.test(run) ? '' : '\n';
      }),
      // One sentence per line: only before a capital letter, and not after a short form or a single initial.
      sentences: line => line.replace(/([.!?…]["”’)\]]*)[ \t]+(?=["“‘(\[]*\p{Lu})/gu, (match, stop, offset) => {
        const before = line.slice(Math.max(0, offset - 8), offset);
        return stop[0] === '.' && (NO_BREAK_AFTER.test(before) || INITIAL.test(before)) ? match : stop + '\n';
      }),
    }[mode];
    if (!split) throw new Error(`Unknown line-break rule: ${mode}`);
    for (const line of source.lines) {
      const pieces = split(line).split('\n');
      added += pieces.length - 1;
      result.push(...pieces);
    }
    changes.push({ what: 'Line breaks added', count: added });
  }
  return close(result, source, changes, extra);
}

// The first-version operations of issue 45 (table formatting removed 24 September 2026). A fixed list on purpose, not a registry.
export function run(operation, text, options = {}) {
  switch (operation) {
    case 'sort': return sortLines(text, options);
    case 'markers': return removeListMarkers(text);
    case 'case': return changeCase(text, options);
    case 'tidy': return tidy(text, options);
    case 'breaks': return fixLineBreaks(text, options);
    default: throw new Error(`Unknown operation: ${operation}`);
  }
}

// Compares two lists, one item on each line (issue 72). Nothing is rewritten. Blank lines are left
// out and counted. Two lines are the same item only when every character matches, unless the person
// chose to ignore capitals or the spaces at the ends of a line; those choices change what is compared,
// never what is shown. Each item is shown as it was first written, with any other ways it was written.
// Order is first appearance: the first list's for "both" and "only in the first", the second's for the rest.
export function compareLists(first, second, { ignoreCase = false, trimEnds = false } = {}) {
  const keyOf = (line, loose) => {
    const key = trimEnds || loose ? line.trim() : line;
    return ignoreCase || loose ? key.toLowerCase() : key;
  };
  const items = new Map();
  const read = (text, side) => {
    const lines = open(text).lines, kept = lines.filter(line => line.trim());
    for (const line of kept) {
      const key = keyOf(line);
      if (!items.has(key)) items.set(key, { item: line, first: 0, second: 0, written: new Set() });
      const entry = items.get(key);
      entry[side]++; entry.written.add(line);
    }
    const mine = [...items.values()].filter(entry => entry[side]);
    return { lines: kept.length, items: mine.length, repeated: mine.filter(entry => entry[side] > 1).length, blank: lines.length - kept.length };
  };
  const counts = { first: read(first, 'first'), second: read(second, 'second') };
  const entries = [...items.values()].map(entry => ({ ...entry, written: entry.written.size > 1 ? [...entry.written] : [] }));
  const onlyFirst = entries.filter(entry => !entry.second), onlySecond = entries.filter(entry => !entry.first);
  // Items in one list only that are in the other apart from capitals or end spaces: counted, so the person can decide.
  const loose = side => new Set(entries.filter(entry => entry[side]).map(entry => keyOf(entry.item, true)));
  const inFirst = loose('first'), inSecond = loose('second');
  return {
    both: entries.filter(entry => entry.first && entry.second), onlyFirst, onlySecond, ...counts,
    nearly: onlyFirst.filter(entry => inSecond.has(keyOf(entry.item, true))).length + onlySecond.filter(entry => inFirst.has(keyOf(entry.item, true))).length,
  };
}
