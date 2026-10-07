import {readFile,writeFile} from 'node:fs/promises';
const entries = {
 '显示更多':['Show more','さらに表示','더 보기','Mehr anzeigen','Mostrar más','Показать ещё','Hiển thị thêm'],
 '项目图标':['Item icon','項目のアイコン','항목 아이콘','Eintragssymbol','Icono del elemento','Значок записи','Biểu tượng mục'],
 '更换图标':['Change icon','アイコンを変更','아이콘 변경','Symbol ändern','Cambiar icono','Изменить значок','Đổi biểu tượng'],
 '跟随网站':['Use website icon','サイトのアイコンを使用','웹사이트 아이콘 사용','Websitesymbol verwenden','Usar icono del sitio','Значок сайта','Dùng biểu tượng trang web'],
 '图标库':['Icon library','アイコンライブラリ','아이콘 라이브러리','Symbolbibliothek','Biblioteca de iconos','Библиотека значков','Thư viện biểu tượng'],
 '搜索图标名称':['Search icon names','アイコン名を検索','아이콘 이름 검색','Symbolnamen suchen','Buscar nombres de iconos','Поиск значков по имени','Tìm tên biểu tượng'],
 '没有匹配的图标':['No matching icons','一致するアイコンはありません','일치하는 아이콘 없음','Keine passenden Symbole','No hay iconos coincidentes','Значки не найдены','Không có biểu tượng phù hợp'],
 '请输入一个有效的 Emoji':['Enter one valid emoji','有効な絵文字を1つ入力してください','올바른 이모지 하나를 입력하세요','Ein gültiges Emoji eingeben','Introduce un emoji válido','Введите один допустимый эмодзи','Nhập một emoji hợp lệ'],
 '使用这个 Emoji':['Use this emoji','この絵文字を使用','이 이모지 사용','Dieses Emoji verwenden','Usar este emoji','Использовать этот эмодзи','Dùng emoji này'],
 '当前图标不可预览，保存时保留':['The current icon cannot be previewed; it will be preserved','現在のアイコンはプレビューできません。保存時に保持されます','현재 아이콘을 미리 볼 수 없습니다. 저장 시 유지됩니다','Das aktuelle Symbol kann nicht angezeigt werden; es bleibt erhalten','El icono actual no se puede previsualizar; se conservará','Предпросмотр текущего значка недоступен; он будет сохранён','Không thể xem trước biểu tượng hiện tại; biểu tượng sẽ được giữ lại'],
};
for(const [index,locale] of ['en','ja','ko','de','es','ru','vi'].entries()) {
 const path = new URL(locale==='en'?'../src/i18n/ui-en.json':`../public/locales/ui-${locale}.json`,import.meta.url);
 const data=JSON.parse(await readFile(path,'utf8'));
 for(const [key,values] of Object.entries(entries)) data[key]=values[index];
 await writeFile(path,JSON.stringify(data,null,2)+'\n');
}
