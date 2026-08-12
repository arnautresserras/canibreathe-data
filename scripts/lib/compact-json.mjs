// Snapshot serializer: pretty-printed JSON, except arrays of primitives, which
// are collapsed onto one line.
//
// Pretty-printing keeps the archive reviewable by hand, but one number per
// indented line does not survive hourly data: 24 stations x 6 taxa x 120 hours is
// ~250 KB/day of mostly whitespace. Collapsing primitive arrays keeps the file
// diffable (each array is one line) while removing that overhead.
//
// Extracted into its own module so it can be unit-tested: it touches every byte
// of the archive, and a silent corruption here would be discovered years later,
// when the data is finally analysed and cannot be re-collected.
//
// Implemented as a direct recursive renderer rather than JSON.stringify + a
// marker string + a regex unwrap. The marker approach was tried first and is
// unsafe: any *value* in the payload containing the marker gets unwrapped into a
// raw array literal, producing invalid JSON. Payload strings here come from third
// parties (raw PIA XML, Google response bodies), so "no realistic input would
// contain it" is not a property worth betting an unrepeatable archive on. This
// version has no injection surface — every string still goes through
// JSON.stringify, which is the only thing that escapes it.

// Below this length, one-per-line stays more readable and the saving is
// negligible. Daily weather arrays (5 elements, one per forecast day) sit just
// above the line and benefit.
const MIN_COMPACT_LENGTH = 5;

function isPrimitiveArray(value) {
  return (
    Array.isArray(value) &&
    value.length >= MIN_COMPACT_LENGTH &&
    value.every((v) => v === null || typeof v === 'number' || typeof v === 'string')
  );
}

function render(value, depth) {
  // Match JSON.stringify's toJSON contract, so a Date or similar can't render
  // as "{}" here while stringifying correctly everywhere else.
  if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') {
    return render(value.toJSON(), depth);
  }

  // Primitives, and the NaN/Infinity -> null coercion, are JSON.stringify's job.
  // `undefined` only reaches here as an array element, where JSON emits null.
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  const pad = '  '.repeat(depth);
  const padInner = '  '.repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isPrimitiveArray(value)) return JSON.stringify(value);
    const items = value.map((item) => padInner + render(item, depth + 1));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  // Object keys whose value is undefined are dropped, as JSON.stringify does.
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  const props = entries.map(
    ([key, v]) => `${padInner}${JSON.stringify(key)}: ${render(v, depth + 1)}`
  );
  return `{\n${props.join(',\n')}\n${pad}}`;
}

/**
 * JSON.stringify with 2-space indentation, but arrays of primitives on one line.
 *
 * Guarantees the output parses back to the same value JSON.stringify would have
 * produced. That check runs on every call: it costs one parse per snapshot per
 * day, and it means a future edit to this file cannot silently corrupt the
 * archive — it fails the run instead, loudly, while the data is still fetchable.
 *
 * @param {unknown} payload
 * @returns {string} valid JSON
 * @throws {Error} if the rendered text does not round-trip
 */
export function serializeSnapshot(payload) {
  const text = render(payload, 0);

  let reparsed;
  try {
    reparsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`serializeSnapshot produced invalid JSON: ${e.message}`);
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(payload)) {
    throw new Error('serializeSnapshot round-trip mismatch — refusing to write a corrupt snapshot');
  }
  return text;
}
