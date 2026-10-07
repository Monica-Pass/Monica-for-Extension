import { readFile, writeFile } from 'node:fs/promises';
const entries = {
  '项目密码': ['Project passwords','プロジェクトのパスワード','프로젝트 비밀번호','Projektpasswörter','Contraseñas del proyecto','Пароли проекта','Mật khẩu dự án'],
  '同一项目': ['Same project','同じプロジェクト','같은 프로젝트','Dasselbe Projekt','Mismo proyecto','Один проект','Cùng dự án'],
  '未填写用户名': ['No username','ユーザー名なし','사용자 이름 없음','Kein Benutzername','Sin nombre de usuario','Имя пользователя не указано','Chưa có tên người dùng'],
  '{0} 条密码': ['{0} passwords','パスワード {0} 件','비밀번호 {0}개','{0} Passwörter','{0} contraseñas','Паролей: {0}','{0} mật khẩu'],
  '{0} 个凭据组 · {1} 条密码': ['{0} credential groups · {1} passwords','認証情報グループ {0} 件 · パスワード {1} 件','자격 증명 그룹 {0}개 · 비밀번호 {1}개','{0} Anmeldedatengruppen · {1} Passwörter','{0} grupos de credenciales · {1} contraseñas','Групп учётных данных: {0} · Паролей: {1}','{0} nhóm thông tin đăng nhập · {1} mật khẩu'],
  '{0} · 密码 {1}': ['{0} · Password {1}','{0} · パスワード {1}','{0} · 비밀번호 {1}','{0} · Passwort {1}','{0} · Contraseña {1}','{0} · Пароль {1}','{0} · Mật khẩu {1}'],
  '密码项目需包含 1–100 个不同的成员。': ['A password project must contain 1–100 distinct members.','パスワードプロジェクトには異なるメンバーが 1～100 件必要です。','비밀번호 프로젝트에는 서로 다른 항목이 1~100개 있어야 합니다.','Ein Passwortprojekt muss 1–100 unterschiedliche Einträge enthalten.','Un proyecto de contraseñas debe contener entre 1 y 100 miembros distintos.','Проект паролей должен содержать от 1 до 100 разных записей.','Dự án mật khẩu phải có từ 1 đến 100 mục riêng biệt.'],
  '将项目“{0}”中的 {1} 条密码移到回收站？': ['Move {1} passwords in “{0}” to the recycle bin?','「{0}」のパスワード {1} 件をゴミ箱に移動しますか？','“{0}”의 비밀번호 {1}개를 휴지통으로 이동할까요?','{1} Passwörter in „{0}“ in den Papierkorb verschieben?','¿Mover {1} contraseñas de «{0}» a la papelera?','Переместить пароли ({1}) проекта «{0}» в корзину?','Chuyển {1} mật khẩu trong “{0}” vào thùng rác?'],
  '已将 {0} 条密码移到回收站。': ['Moved {0} passwords to the recycle bin.','パスワード {0} 件をゴミ箱に移動しました。','비밀번호 {0}개를 휴지통으로 이동했습니다.','{0} Passwörter wurden in den Papierkorb verschoben.','Se han movido {0} contraseñas a la papelera.','Паролей перемещено в корзину: {0}.','Đã chuyển {0} mật khẩu vào thùng rác.']
};
for (const [index, locale] of ['en','ja','ko','de','es','ru','vi'].entries()) {
  const path = new URL(locale === 'en' ? '../src/i18n/ui-en.json' : `../public/locales/ui-${locale}.json`, import.meta.url);
  const data = JSON.parse(await readFile(path, 'utf8'));
  for (const [key, values] of Object.entries(entries)) data[key] = values[index];
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}
