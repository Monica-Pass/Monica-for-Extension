import assert from 'node:assert/strict';
import ts from 'typescript';

/** Simulate an older dispatcher without depending on the minifier's key quotes
 * or altering command strings in unrelated policy/transport code. */
export function olderRuntimeWorker(source) {
  const renames = new Map([
    ['VAULT_LOCKED_AUTOFILL_IDS', 'LEGACY_LOCKED_AUTOFILL_IDS'],
    ['RUNTIME_INFO', 'LEGACY_RUNTIME_INFO']
  ]);
  const parsed = ts.createSourceFile('background.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0, 'Background fixture must parse');
  const edits = [], counts = new Map([...renames.keys()].map(name => [name, 0]));
  function visit(node) {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = node.name.text;
      if (renames.has(name)) {
        counts.set(name, counts.get(name) + 1);
        edits.push({ start: node.name.getStart(parsed), end: node.name.getEnd(), value: JSON.stringify(renames.get(name)) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const [name, count] of counts) assert.equal(count, 1, `Expected exactly one ${name} route`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}
