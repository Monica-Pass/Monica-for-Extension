import {readFile,writeFile} from 'node:fs/promises';
const entries={
 '数据库信息':['Database information','データベース情報','데이터베이스 정보','Datenbankinformationen','Información de la base de datos','Сведения о базе данных','Thông tin cơ sở dữ liệu'],
 '连接状态':['Connection','接続状態','연결 상태','Verbindung','Conexión','Подключение','Kết nối'],
 '离线访问':['Offline access','オフラインアクセス','오프라인 접근','Offline-Zugriff','Acceso sin conexión','Доступ офлайн','Truy cập ngoại tuyến'],
 '云端保存':['Cloud save','クラウドへの保存','클라우드 저장','Cloud-Speicherung','Guardado en la nube','Сохранение в облаке','Lưu trên đám mây'],
 '尚未同步':['Not synced yet','未同期','아직 동기화되지 않음','Noch nicht synchronisiert','Aún sin sincronizar','Ещё не синхронизировано','Chưa đồng bộ']
};
for(const [index,locale] of ['en','ja','ko','de','es','ru','vi'].entries()) {
 const path=new URL(locale==='en'?'../src/i18n/ui-en.json':`../public/locales/ui-${locale}.json`,import.meta.url), data=JSON.parse(await readFile(path,'utf8'));
 for(const [key,values] of Object.entries(entries)) data[key]=values[index];
 await writeFile(path,JSON.stringify(data,null,2)+'\n');
}
