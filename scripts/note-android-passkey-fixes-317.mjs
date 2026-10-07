import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../Monica-main');
const sections = {
  '### 简要': '- 修复 Passkey 跨端标识与备注兼容；认证取消会真正退出，选择账户时不显示私人备注。',
  '### 详细': '- 保留 UUID、Base64URL 与 Bitwarden `b64.` 格式的原始凭据字节；允许列表无匹配时不再改用其他凭据，并在认证前再次校验所选账户与实际请求。\n- Bitwarden 原生 Passkey 备注保留完整正文、分隔线与空白，支持清空；旧引用条目仍保留可恢复的元数据，不改写既有私钥。',
  '### Summary': '- Fix Passkey ID and note compatibility across clients; cancellation exits authentication, and account selection keeps private notes hidden.',
  '### Details': '- Preserve original credential bytes across UUID, Base64URL and Bitwarden `b64.` formats. Unmatched allow-lists no longer fall back to other credentials; authentication rechecks the selected account against the actual request.\n- Preserve native Bitwarden Passkey notes, separators, whitespace and explicit clearing. Legacy reference-only entries retain recovery metadata without replacing existing private keys.',
};
for (const file of ['Monica Android发行说明.md', 'fdroid/Monica F-Droid发行说明.md']) {
  const target = path.join(root, file), raw = await readFile(target, 'utf8');
  let text = raw.replaceAll('\r\n', '\n');
  if (!text.startsWith('# Monica') || !text.includes('1.0.317') || !text.includes('Unreleased')) throw new Error('Not current unreleased notes');
  for (const [heading, entry] of Object.entries(sections)) {
    if (text.includes(entry)) continue;
    if (text.split(heading + '\n').length !== 2) throw new Error('Unrecognized notes heading');
    text = text.replace(heading + '\n', heading + '\n\n' + entry + '\n');
  }
  await writeFile(target, text);
}
for (const [locale, entry] of [['zh-CN', '- 修复 Passkey 跨端凭据标识与备注保留，严格匹配允许列表；取消认证会退出，账户选择不显示私人备注。'],
  ['en-US', '- Fix Passkey credential IDs, note preservation and strict allow-list matching. Cancel exits authentication; account selection keeps private notes hidden.']]) {
  const file = path.join(root, 'fdroid/fastlane/metadata/android', locale, 'changelogs/24.txt');
  const prior = await readFile(file, 'utf8');
  if (!prior.includes(entry) && !prior.includes('Passkeys: preserve IDs/notes, enforce allow-lists'))
    await writeFile(file, prior.trimEnd() + '\n' + entry + '\n');
}
console.log('Updated ordinary and F-Droid unreleased 1.0.317 notes only');
