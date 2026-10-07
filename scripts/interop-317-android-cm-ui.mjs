import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

const out = process.env.MONICA_CM_EVIDENCE_DIR ? resolve(process.env.MONICA_CM_EVIDENCE_DIR) : resolve(import.meta.dirname, process.env.MONICA_CM_BACKENDS === '1' ? '../.tmp/android-cm-backends-317' : '../.tmp/android-credential-manager-317');
function adb(args) {
  const r = spawnSync('D:/AndroidSDK/platform-tools/adb.exe', ['-s', 'emulator-5560', ...args], { windowsHide: true, timeout: 30000, maxBuffer: 32e6 });
  if (r.status !== 0) throw new Error(`ADB failed: ${r.error || r.stderr}`);
  return r.stdout;
}
const mode = process.argv[2], value = process.argv[3];
adb(['shell', 'uiautomator', 'dump', '/data/local/tmp/cm317-ui.xml']);
const xml = adb(['shell', 'cat', '/data/local/tmp/cm317-ui.xml']);
const doc = new DOMParser().parseFromString(xml.toString(), 'text/xml');
const nodes = Array.from(doc.getElementsByTagName('node'));
const attr = (n, key) => n.getAttribute(key);
if (mode === 'snapshot') {
  if (!/^[a-z0-9-]+$/.test(value)) throw new Error('Invalid evidence tag');
  await writeFile(join(out, `${value}.xml`), xml);
  adb(['shell', 'screencap', '-p', '/data/local/tmp/cm317-screen.png']);
  adb(['pull', '/data/local/tmp/cm317-screen.png', join(out, `${value}.png`)]);
  console.log(JSON.stringify(nodes.filter(n => attr(n, 'text') || attr(n, 'content-desc') || attr(n, 'class') === 'android.widget.EditText')
    .map(n => ({ text: attr(n, 'text'), description: attr(n, 'content-desc'), class: attr(n, 'class'), bounds: attr(n, 'bounds') }))));
} else if (mode === 'tap-text' || mode === 'tap-edit') {
  const found = nodes.filter(n => mode === 'tap-edit' ? attr(n, 'class') === 'android.widget.EditText' : attr(n, 'text') === value || attr(n, 'content-desc') === value);
  if (found.length !== 1) throw new Error(`Expected one UI target, found ${found.length}`);
  const coordinates = attr(found[0], 'bounds').match(/\d+/g).map(Number);
  adb(['shell', 'input', 'tap', String(Math.round((coordinates[0] + coordinates[2]) / 2)), String(Math.round((coordinates[1] + coordinates[3]) / 2))]);
  console.log('Tapped observed UI target');
} else throw new Error('Unknown UI stage');
