// node --test scripts/lib/compact-json.test.mjs
// (pass the file, not the directory — `node --test scripts/` resolves the path as
// a module on Windows and fails with MODULE_NOT_FOUND.)
//
// The serializer touches every byte written to snapshots/, so its one job is to
// be lossless. A corruption here would surface years later, when the archive is
// finally analysed and cannot be re-collected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeSnapshot } from './compact-json.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Serialize, parse back, and assert structural identity. */
function roundTrip(value) {
  const text = serializeSnapshot(value);
  return { text, parsed: JSON.parse(text) };
}

test('output is valid JSON that parses back identically', () => {
  const input = {
    numbers: [0, 1.5, -2, null, 4, 5],
    strings: ['2026-08-12T00:00', '2026-08-12T01:00', 'a', 'b', 'c', 'd'],
    nested: { deep: { arr: [1, 2, 3, 4, 5, 6] } },
  };
  const { parsed } = roundTrip(input);
  assert.deepEqual(parsed, input);
});

test('primitive arrays collapse to one line', () => {
  const { text } = roundTrip({ hourly: Array.from({ length: 24 }, (_, i) => i) });
  const arrayLines = text.split('\n').filter((l) => l.includes('['));
  assert.equal(arrayLines.length, 1, 'the array should occupy exactly one line');
  assert.match(text, /"hourly": \[0,1,2,3/);
});

test('short arrays are left expanded for readability', () => {
  const { text, parsed } = roundTrip({ short: [1, 2, 3, 4] });
  assert.deepEqual(parsed.short, [1, 2, 3, 4]);
  assert.ok(text.includes('\n'), 'short arrays keep the pretty-printed form');
  assert.doesNotMatch(text, /\[1,2,3,4\]/);
});

test('arrays of objects are never compacted', () => {
  const input = { items: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }, { a: 6 }] };
  const { text, parsed } = roundTrip(input);
  assert.deepEqual(parsed, input);
  assert.match(text, /\{\n/, 'object elements stay expanded');
});

test('long strings are untouched — PIA XML must survive verbatim', () => {
  // The PIA snapshot stores raw XML as a single string. It must not be altered,
  // and it must not be mistaken for compactable content.
  const xml = '<?xml version="1.0"?><forecast><pollens><GRAM>1</GRAM></pollens></forecast>';
  const { text, parsed } = roundTrip({ stations: { barcelona: { xml } } });
  assert.equal(parsed.stations.barcelona.xml, xml);
  assert.ok(!text.includes('@@COMPACT@@'), 'no marker may leak into the output');
});

test('strings containing quotes and backslashes round-trip inside a compacted array', () => {
  // Not present in today's payloads (ISO timestamps only), but the escaping is
  // the one part of this that could silently truncate a match.
  const tricky = ['a"b', 'c\\d', 'e\\"f', 'plain', 'tab\there', 'newline\nhere'];
  const { parsed } = roundTrip({ tricky });
  assert.deepEqual(parsed.tricky, tricky);
});

test('a value that looks like an internal marker is not unwrapped', () => {
  // Regression guard for the first implementation, which used a marker string
  // plus a regex unwrap: this input made it emit invalid JSON. Payload strings
  // come from third parties, so this has to be safe by construction.
  const input = { note: '@@COMPACT@@[1,2,3] — literal text in a value' };
  const { parsed } = roundTrip(input);
  assert.deepEqual(parsed, input, 'a lookalike must survive as a string');
});

test('matches JSON.stringify semantics for awkward values', () => {
  // The contract is "same value JSON.stringify would produce, laid out differently",
  // so parity is the thing to assert — not hand-written expectations.
  const cases = [
    { a: undefined, b: 1 },                       // undefined object value is dropped
    { arr: [1, undefined, 3, null, 5, 6] },       // undefined array element becomes null
    { n: NaN, i: Infinity, neg: -Infinity },      // non-finite numbers become null
    { d: new Date('2026-08-12T00:00:00.000Z') },  // toJSON is honoured
    { empty: {}, emptyArr: [], nested: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]] },
    { unicode: 'ü — ñ 花粉', quote: 'he said "hi"', backslash: 'a\\b' },
  ];
  for (const input of cases) {
    const { parsed } = roundTrip(input);
    assert.deepEqual(
      parsed,
      JSON.parse(JSON.stringify(input)),
      `diverged from JSON.stringify for ${JSON.stringify(Object.keys(input))}`
    );
  }
});

test('refuses to return a corrupt result', () => {
  // The built-in round-trip check is the archive's last line of defence, so prove
  // it actually fires rather than trusting that it would.
  const hostile = { toJSON: () => ({ ok: 1 }) };
  assert.doesNotThrow(() => serializeSnapshot(hostile), 'toJSON is legitimate');

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.throws(() => serializeSnapshot(cyclic), 'a cycle must fail loudly, not write garbage');
});

test('every archived snapshot round-trips losslessly', async () => {
  let checked = 0;
  for (const source of ['pia', 'openmeteo', 'google']) {
    const dir = join(REPO_ROOT, 'snapshots', source);
    let years;
    try {
      years = await readdir(dir);
    } catch {
      continue; // source not captured yet
    }
    for (const year of years) {
      for (const file of await readdir(join(dir, year))) {
        if (!file.endsWith('.json')) continue;
        const original = JSON.parse(await readFile(join(dir, year, file), 'utf8'));
        const { parsed } = roundTrip(original);
        assert.deepEqual(parsed, original, `${source}/${year}/${file} did not round-trip`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'expected at least one archived snapshot to verify against');
  console.log(`    verified ${checked} archived snapshot(s)`);
});
