import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const file = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(file, 'utf8'));
const id = 'sourcestatus315', x = 14500;
doc.frames = doc.frames.filter(frame => frame.id !== id);
doc.groups = doc.groups.filter(group => group.frameId !== id);
doc.frames.push({id,name:'Android 竖屏 · 密码来源状态',x,y:0,w:420,h:860});
const group = (name,y,items,gap=4) => doc.groups.push({id:`${id}-${name}`,frameId:id,x:x+12,y,axis:'y',gap,items:items.map((item,index)=>({id:`${id}-${name}-${index}`,size:396,variant:'filled',radius:24,...item}))});
group('search',12,[{kind:'searchBar',label:'搜索当前分类',icon:'search'}]);
group('heading',90,[{kind:'topAppBar',label:'密码源',icon:'database'}]);
group('file',174,[{kind:'listItem',label:'个人 KeePass',supporting:'personal.kdbx',icon:'key'}]);
group('status',264,[
  {kind:'listItem',label:'连接状态',supporting:'已解锁',icon:'lock_open',radius:4,corners:{tl:24,tr:24,bl:4,br:4}},
  {kind:'listItem',label:'离线访问',supporting:'可用',icon:'offline_pin',radius:4},
  {kind:'listItem',label:'云端保存',supporting:'已同步',icon:'cloud_done',radius:4,corners:{tl:4,tr:4,bl:24,br:24}}
]);
group('info',496,[{kind:'listItem',label:'数据库信息',supporting:'项目数量、加密与解锁保护',icon:'info'}]);
group('actions',584,[{kind:'button',label:'立即同步',icon:'sync'},{kind:'button',label:'管理分组',icon:'folder_managed',variant:'tonal'}]);
group('manage',712,[{kind:'button',label:'管理 KeePass',icon:'settings',variant:'text'}]);
doc.groups.push({id:`${id}-nav`,frameId:id,x,y:780,axis:'y',gap:0,items:[{id:`${id}-bottom`,kind:'bottomNav',label:'主导航',icon:'',variant:'filled',size:420,selected:3,tabs:[{icon:'password',label:'登录项'},{icon:'timer',label:'动态验证码'},{icon:'wallet',label:'钱包与身份'},{icon:'menu',label:'更多'}]}]});
const json=JSON.stringify(doc,null,2)+'\n'; await writeFile(file,json);
await writeFile(new URL('../docs/design/source-status-315.md',import.meta.url),`# 密码来源状态\n\n沿用 Android 数据库管理的12dp页边距与设置页连续分组：外侧24px、相邻4px，状态采用图标、标签、值的清晰层级。保留现有动态配色和字体，使用主题surface容器；标题24px、正文14px、状态值16px。三个状态分别回答是否已连接、能否离线访问、修改是否保存到云端。删除面向实现的ETag与基线摘要；恢复和冲突仍提供原有可操作提示。同步与管理入口保留。\n\n[本地可编辑 Canvas](http://127.0.0.1:5186/#docz=${deflateRawSync(json).toString('base64url')})\n`);
