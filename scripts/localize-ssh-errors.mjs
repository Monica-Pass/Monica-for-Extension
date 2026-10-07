import {readFile,writeFile} from 'node:fs/promises';
const message='SSH 数据格式无法安全保存，请检查密钥信息；原记录未修改。';
const values=[
 'SSH data cannot be saved safely. Check the key information; the original record was not changed.',
 'SSHデータを安全に保存できません。鍵の情報を確認してください。元のレコードは変更されていません。',
 'SSH 데이터를 안전하게 저장할 수 없습니다. 키 정보를 확인하세요. 기존 기록은 변경되지 않았습니다.',
 'Die SSH-Daten können nicht sicher gespeichert werden. Prüfen Sie die Schlüsselinformationen; der ursprüngliche Eintrag wurde nicht geändert.',
 'Los datos SSH no se pueden guardar de forma segura. Revisa la información de la clave; el registro original no se modificó.',
 'Данные SSH нельзя безопасно сохранить. Проверьте сведения о ключе; исходная запись не изменена.',
 'Không thể lưu dữ liệu SSH an toàn. Hãy kiểm tra thông tin khóa; bản ghi gốc chưa bị thay đổi.'
];
for(const [index,locale] of ['en','ja','ko','de','es','ru','vi'].entries()) {
 const path=new URL(locale==='en'?'../src/i18n/ui-en.json':`../public/locales/ui-${locale}.json`,import.meta.url),data=JSON.parse(await readFile(path,'utf8'));
 data[message]=values[index]; await writeFile(path,JSON.stringify(data,null,2)+'\n');
}
