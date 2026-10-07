import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const path = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(path, 'utf8'));
const id = 'customicons315', x = 11500;
doc.frames = doc.frames.filter(frame => frame.id !== id);
doc.groups = doc.groups.filter(group => group.frameId !== id);
doc.frames.push({ id, name: '项目图标 · 离线选择与预览', x, y: 0, w: 420, h: 980 });
const rows = [
  [20, 'topAppBar', '项目图标', 'arrow_back', ''],
  [96, 'listItem', 'Example 账号', 'key', '当前：自动图标'],
  [190, 'listItem', '跟随网站', 'language', '清除自定义图标，恢复自动显示'],
  [278, 'listItem', '从图标库选择', 'apps', '与 Android 一致的离线品牌图标'],
  [366, 'listItem', '使用 Emoji', 'mood', '保留组合表情、肤色与旗帜'],
  [474, 'searchBar', '搜索图标名称', 'search', ''],
  [550, 'listItem', 'GitHub', 'code', '已选中 · 保存前可以继续更换'],
  [644, 'textField', 'Emoji', 'mood', '🔑'],
  [748, 'listItem', '预览 · Example 账号', 'key', '应用到列表和详情'],
  [858, 'button', '完成', 'check', ''],
];
rows.forEach(([y,kind,label,icon,supporting],index) => doc.groups.push({id:`${id}-g${index}`,frameId:id,x:x+12,y,axis:'y',gap:4,
  items:[{id:`${id}-i${index}`,kind,label,icon,variant:'filled',size:396,supporting,radius:24}]}));
doc.brief += ' 图标选择：参照Android CustomIconActionDialog，离线搜索与Emoji预览，保留未知和未同步上传图标；选择暂存在草稿，保存项目后生效。';
const json = JSON.stringify(doc,null,2)+'\n';
await writeFile(path,json);
await writeFile(new URL('../docs/design/custom-icons-315.md',import.meta.url),`# 项目图标\n\n参考 Android CustomIconActionDialog、PasswordCustomIconSupport 和 EmojiIconSupport。图标库使用现有离线资源；Emoji 使用单个有效序列。上传图标的 Android 私有文件路径不能直接在浏览器解析，保持原值直到用户明确替换。\n\n[可编辑本地 M3E Canvas](http://127.0.0.1:5186/#docz=${deflateRawSync(json).toString('base64url')})\n`);
