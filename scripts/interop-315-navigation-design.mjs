import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const file = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(file, 'utf8'));
const id = 'navigation315', x = 13000;
doc.frames = doc.frames.filter(frame => frame.id !== id);
doc.groups = doc.groups.filter(group => group.frameId !== id);
doc.frames.push({ id, name: 'Android 竖屏 · 卡包与底部导航', x, y: 0, w: 420, h: 860 });
const rows = [
  [12, 'searchBar', '搜索当前分类', 'search', ''],
  [92, 'button', '添加钱包项目', 'add', ''],
  [158, 'topAppBar', '钱包与身份', 'wallet', ''],
  [232, 'select', '当前数据库', 'database', '全部数据库'],
  [320, 'chip', '全部类型', '', ''],
  [390, 'listItem', '日常消费卡', 'credit_card', '银行卡 · 仅显示尾号 4242'],
  [478, 'listItem', '旅行信用卡', 'credit_card', '银行卡 · 仅显示尾号 8080'],
  [566, 'listItem', '身份证件', 'badge', '证件 · 隐藏证件号码'],
];
rows.forEach(([y, kind, label, icon, supporting], i) => doc.groups.push({ id: `${id}-g${i}`, frameId: id, x: x + 12, y, axis: 'y', gap: 4, items: [{ id: `${id}-i${i}`, kind, label, icon, supporting, size: 396, radius: 24, variant: 'filled' }] }));
doc.groups.push({ id: `${id}-nav`, frameId: id, x, y: 780, axis: 'y', gap: 0, items: [{ id: `${id}-nav-item`, kind: 'bottomNav', label: '主导航', icon: '', variant: 'filled', size: 420, selected: 2, tabs: [{icon:'password',label:'登录项'},{icon:'timer',label:'动态验证码'},{icon:'wallet',label:'钱包与身份'},{icon:'menu',label:'更多'}] }] });
const json = JSON.stringify(doc, null, 2) + '\n';
await writeFile(file, json);
await writeFile(new URL('../docs/design/navigation-315.md', import.meta.url), `# 竖屏常用导航\n\n参照 Android SimpleMainScreen 的 NavigationBar 和 CardWalletScreen 的分类浏览。宽度不超过 580px 时使用 80px M3E 底栏，常用入口为登录项、动态验证码、钱包与身份；更多打开原有完整导航。内容左右 12px，底部预留导航和安全区域，保留现有卡面设计。选中状态跟随页面；关闭抽屉返回触发按钮；桌面隐藏底栏。沿用动态配色和字体。\n\n此页用列表组件表达信息与导航顺序；卡面图像和显示模式沿用已保存的钱包设计帧与真实组件，不在草图中制造假图片。\n\n[本地可编辑 Canvas](http://127.0.0.1:5186/#docz=${deflateRawSync(json).toString('base64url')})\n`);
