import {readFile,writeFile} from 'node:fs/promises';
import {deflateRawSync} from 'node:zlib';
const file=new URL('../docs/design/android-interop-315.m3e.json',import.meta.url);
const doc=JSON.parse(await readFile(file,'utf8'));
const id='portrait315',x=12000;
doc.frames=doc.frames.filter(f=>f.id!==id);
doc.groups=doc.groups.filter(g=>g.frameId!==id);
doc.frames.push({id,name:'Android 竖屏 · 全屏新建密码',x,y:0,w:420,h:860});
const rows=[
 [8,'topAppBar','添加密码','close',''],
 [84,'listItem','项目图标','key','跟随网站'],
 [180,'textField','名称 *','','Example 账号'],
 [276,'select','保存到','folder','个人保险库'],
 [384,'textField','用户名','person','user@example.com'],
 [480,'textField','密码','key','••••••••••••'],
 [588,'listItem','网站与应用','language','添加登录地址或关联应用'],
 [676,'listItem','更多信息','expand_more','备注、验证码和恢复码'],
 [780,'button','加密保存','check',''],
];
rows.forEach(([y,kind,label,icon,supporting],i)=>doc.groups.push({id:`${id}-g${i}`,frameId:id,x:x+12,y,axis:'y',gap:4,items:[{id:`${id}-i${i}`,kind,label,icon,supporting,size:396,radius:24,variant:'filled'}]}));
const json=JSON.stringify(doc,null,2)+'\n';await writeFile(file,json);
await writeFile(new URL('../docs/design/portrait-315.md',import.meta.url),`# Android 竖屏页面\n\n参照 Android PasswordDetailScreen 的 Scaffold、TopAppBar 与 12dp 内容边距。浏览器宽度不超过 580px 时，新建、编辑、详情使用全屏容器；字段单独滚动，顶部关闭与底部操作保持可达。桌面保留对话框。复用现有动态颜色及字体，不引入另一套视觉主题。\n\n[本地可编辑 Canvas](http://127.0.0.1:5186/#docz=${deflateRawSync(json).toString('base64url')})\n`);
