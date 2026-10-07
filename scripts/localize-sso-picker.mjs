import {readFile,writeFile} from 'node:fs/promises';
const entries={
 '关联账号':['Linked account','連携アカウント','연결된 계정','Verknüpftes Konto','Cuenta vinculada','Связанный аккаунт','Tài khoản liên kết'],
 '不关联账号':['No linked account','連携しない','계정 연결 안 함','Kein verknüpftes Konto','Sin cuenta vinculada','Без связанного аккаунта','Không liên kết tài khoản'],
 '解除账号关联':['Unlink account','アカウントの連携を解除','계정 연결 해제','Kontoverknüpfung aufheben','Desvincular cuenta','Отвязать аккаунт','Hủy liên kết tài khoản'],
 '此来源暂不支持修改账号关联，原有关联已保留。':['This source cannot edit account links yet. The existing link is preserved.','この保存先では連携アカウントを変更できません。既存の連携は保持されます。','이 저장소는 아직 계정 연결 편집을 지원하지 않습니다. 기존 연결은 유지됩니다.','Diese Quelle unterstützt das Bearbeiten von Kontoverknüpfungen noch nicht. Die bestehende Verknüpfung bleibt erhalten.','Esta fuente aún no permite editar vínculos de cuentas. Se conserva el vínculo existente.','Этот источник пока не поддерживает изменение связей аккаунтов. Существующая связь сохранена.','Nguồn này chưa hỗ trợ sửa liên kết tài khoản. Liên kết hiện tại được giữ nguyên.'],
};
for(const [index,locale] of ['en','ja','ko','de','es','ru','vi'].entries()) {
 const path=new URL(locale==='en'?'../src/i18n/ui-en.json':`../public/locales/ui-${locale}.json`,import.meta.url),data=JSON.parse(await readFile(path,'utf8'));
 for(const [key,values] of Object.entries(entries))data[key]=values[index];
 await writeFile(path,JSON.stringify(data,null,2)+'\n');
}
