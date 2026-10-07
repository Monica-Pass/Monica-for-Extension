import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const file = new URL('../docs/design/android-interop-315.m3e.json', import.meta.url);
const doc = JSON.parse(await readFile(file, 'utf8'));
const id = 'webdavnote316', x = 15000;
doc.frames = doc.frames.filter(frame => frame.id !== id);
doc.groups = doc.groups.filter(group => group.frameId !== id);
doc.frames.push({id,name:'密码编辑 · WebDAV 关联笔记',x,y:0,w:420,h:860});
const group = (name,y,items,gap=4) => doc.groups.push({id:`${id}-${name}`,frameId:id,x:x+12,y,axis:'y',gap,
  items:items.map((item,index)=>({id:`${id}-${name}-${index}`,size:396,variant:'filled',radius:24,...item}))});
group('heading',12,[{kind:'topAppBar',label:'编辑密码',icon:'close'}]);
group('name',100,[{kind:'textField',label:'名称',value:'旅行账号',icon:''}]);
group('source',196,[{kind:'select',label:'保存到',selected:0,icon:'cloud',tabs:[{label:'Android WebDAV',value:'webdav'}]}]);
group('note',308,[{kind:'select',label:'选择关联笔记',selected:2,icon:'note',tabs:[
  {label:'不关联笔记',value:''},{label:'旅行清单 · 航班与酒店预订',value:'first'},{label:'旅行清单 · 护照与紧急联系人',value:'second'}]}]);
group('preview',408,[{kind:'listItem',label:'旅行清单',supporting:'护照与紧急联系人\n出发前确认保险和证件有效期',icon:'note'}]);
group('unlink',516,[{kind:'button',label:'解除笔记关联',icon:'link_off',variant:'text'}]);
group('notes',602,[{kind:'textField',label:'恢复备注与笔记',value:'账号的补充说明',icon:''}]);
group('save',768,[{kind:'button',label:'加密保存',icon:'check'}]);
const optionsId='webdavnotechoices316', optionsX=x+500;
doc.frames=doc.frames.filter(frame=>frame.id!==optionsId);doc.groups=doc.groups.filter(group=>group.frameId!==optionsId);
doc.frames.push({id:optionsId,name:'关联笔记 · 展开选项',x:optionsX,y:0,w:420,h:860});
doc.groups.push({id:`${optionsId}-options`,frameId:optionsId,x:optionsX+12,y:260,axis:'y',gap:4,items:[
  {kind:'select',label:'选择关联笔记',selected:1,tabs:[{label:'不关联笔记'},{label:'旅行清单'}]},
  {kind:'listItem',label:'不关联笔记',icon:'link_off'},
  {kind:'listItem',label:'旅行清单',supporting:'航班与酒店预订',icon:'note'},
  {kind:'listItem',label:'旅行清单',supporting:'护照与紧急联系人',icon:'check'}
].map((item,index)=>({id:`${optionsId}-${index}`,size:396,variant:'filled',radius:16,icon:'',...item}))});
const json=JSON.stringify(doc,null,2)+'\n'; await writeFile(file,json);
await writeFile(new URL('../docs/design/webdav-note-picker.md',import.meta.url),`# WebDAV 关联笔记\n\n沿用 Android AddEditPasswordScreen 的关联笔记摘要：图标、标题、正文摘要与解除入口。保持项目现有动态 M3E 调色、字体和填充输入框，12px页边距、24px分组圆角，正文摘要两行，长标题换行。下拉选项使用标题与正文摘要两行，实际关联仍按同来源唯一标识。原有但未解析的关联明确显示未找到，取消保留，保存时再次验证来源。\n\n[本地可编辑 Canvas](http://127.0.0.1:5186/#docz=${deflateRawSync(json).toString('base64url')})\n`);
