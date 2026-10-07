import * as kdbxweb from 'kdbxweb';
import { isInRecycleBin } from './keepass-groups';
import { assertKnownKeePassType } from './keepass-writer';

type Binary = kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash;
type Snapshot = Map<string, { binary: Binary; bytes: Uint8Array; protected: boolean }>;
const changed = () => new Error('KeePass 项目附件已变化或存在同名冲突，原成员尚未移除。');

function capture(entry: kdbxweb.KdbxEntry): Snapshot {
  return new Map([...entry.binaries].map(([name, binary]) => {
    const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
    return [name, { binary, bytes: value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value).slice(),
      protected: value instanceof kdbxweb.ProtectedValue }];
  }));
}
function equal(a: Snapshot, b: Snapshot): boolean {
  return a.size === b.size && [...a].every(([name, value]) => {
    const other = b.get(name);
    return other && value.protected === other.protected && value.bytes.length === other.bytes.length
      && value.bytes.every((byte, index) => byte === other.bytes[index]);
  });
}
function clear(snapshot: Snapshot) { for (const row of snapshot.values()) row.bytes.fill(0); }
function attached(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): boolean {
  const visit = (group: kdbxweb.KdbxGroup): boolean => group.entries.includes(entry) || group.groups.some(visit);
  return database.groups.some(visit) && Boolean(entry.parentGroup) && !isInRecycleBin(database, entry.parentGroup!);
}

/** Native, in-memory preparation for one project transaction. It does not delete
 * the old owner or publish a file. Call only after validating project membership,
 * and apply alongside the retained writes before putting the source in the bin.
 * The durable caller must re-prepare after restart; this object retains plaintext
 * comparison bytes until apply/dispose and must never enter a receipt or UI.
 */
export function prepareKeePassProjectAttachmentHandoff(
  database: kdbxweb.Kdbx, source: kdbxweb.KdbxEntry, target: kdbxweb.KdbxEntry
) {
  const sourceUuid = source.uuid.toString(), targetUuid = target.uuid.toString();
  const validate = () => {
    if (source === target || source.uuid.equals(target.uuid) || source.uuid.toString() !== sourceUuid || target.uuid.toString() !== targetUuid
      || !attached(database, source) || !attached(database, target)) throw changed();
    assertKnownKeePassType(source.fields);
    assertKnownKeePassType(target.fields);
  };
  validate();
  const from = capture(source), to = capture(target);
  let disposed = false;
  const dispose = () => { clear(from); clear(to); disposed = true; };
  try {
    for (const [name, value] of from) {
      const existing = to.get(name);
      if (existing && !equal(new Map([[name, value]]), new Map([[name, existing]]))) throw changed();
    }
  } catch (error) { dispose(); throw error; }
  return {
    dispose,
    apply() {
      if (disposed) throw changed();
      let currentSource: Snapshot | undefined, currentTarget: Snapshot | undefined;
      try {
        validate();
        currentSource = capture(source); currentTarget = capture(target);
        if (!equal(from, currentSource) || !equal(to, currentTarget)) throw changed();
        const additions = [...currentSource].filter(([name]) => !currentTarget!.has(name));
        if (!additions.length) return false;
        // Preserve the destination's own password/attachment history. Keep the
        // source binaries intact so restoring its recycle-bin entry is lossless.
        target.pushHistory();
        for (const [name, value] of additions) target.binaries.set(name, value.binary);
        target.times.update();
        return true;
      } finally {
        if (currentSource) clear(currentSource);
        if (currentTarget) clear(currentTarget);
        dispose();
      }
    }
  };
}
