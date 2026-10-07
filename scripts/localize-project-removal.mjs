import { readFile, writeFile } from 'node:fs/promises';
// Locale order: English, Japanese, Korean, German, Spanish, Russian, Vietnamese.
const entries = {
  '撤销移除整组': ['Undo group removal','グループ削除を取り消す','그룹 제거 취소','Gruppenentfernung rückgängig','Deshacer eliminación del grupo','Отменить удаление группы','Hoàn tác xóa nhóm'],
  '移除整组': ['Remove group','グループを削除','그룹 제거','Gruppe entfernen','Eliminar grupo','Удалить группу','Xóa nhóm'],
  '整组待移除，保存项目后生效。': ['This group will be removed when you save.','保存するとこのグループが削除されます。','저장하면 이 그룹이 제거됩니다.','Diese Gruppe wird beim Speichern entfernt.','Este grupo se eliminará al guardar.','Группа будет удалена при сохранении.','Nhóm này sẽ bị xóa khi bạn lưu.'],
  '待移除 · 保存后生效': ['Pending removal · applies on save','削除予定 · 保存時に適用','제거 예정 · 저장 시 적용','Zum Entfernen markiert · beim Speichern','Se eliminará al guardar','Будет удалён при сохранении','Sẽ xóa khi lưu'],
  '撤销移除密码 {0}': ['Undo removal of password {0}','パスワード {0} の削除を取り消す','비밀번호 {0} 제거 취소','Entfernen von Passwort {0} rückgängig','Deshacer eliminación de la contraseña {0}','Отменить удаление пароля {0}','Hoàn tác xóa mật khẩu {0}'],
  '移除密码 {0}': ['Remove password {0}','パスワード {0} を削除','비밀번호 {0} 제거','Passwort {0} entfernen','Eliminar contraseña {0}','Удалить пароль {0}','Xóa mật khẩu {0}'],
  '正在保留共享内容与附件': ['Preserving shared content and attachments','共有内容と添付ファイルを保護しています','공유 내용 및 첨부 파일 보존 중','Gemeinsame Inhalte und Anhänge werden gesichert','Conservando contenido compartido y adjuntos','Сохранение общих данных и вложений','Đang giữ lại nội dung chung và tệp đính kèm'],
  '正在恢复密码与附件': ['Restoring passwords and attachments','パスワードと添付ファイルを復元しています','비밀번호 및 첨부 파일 복원 중','Passwörter und Anhänge werden wiederhergestellt','Restaurando contraseñas y adjuntos','Восстановление паролей и вложений','Đang khôi phục mật khẩu và tệp đính kèm'],
  '正在完成移除': ['Completing removal','削除を完了しています','제거 완료 중','Entfernung wird abgeschlossen','Completando eliminación','Завершение удаления','Đang hoàn tất xóa'],
  '已取消这次移除，其他编辑已保留。': ['Removal cancelled. Other edits are preserved.','削除を取り消しました。他の編集は保持されています。','제거를 취소했습니다. 다른 수정 사항은 유지됩니다.','Entfernung abgebrochen. Andere Änderungen bleiben erhalten.','Eliminación cancelada. Se conservan los demás cambios.','Удаление отменено. Другие изменения сохранены.','Đã hủy xóa. Các chỉnh sửa khác được giữ lại.'],
  '密码移除已完成。': ['Password removal completed.','パスワードの削除が完了しました。','비밀번호 제거가 완료되었습니다.','Passwortentfernung abgeschlossen.','Eliminación de contraseñas completada.','Удаление паролей завершено.','Đã hoàn tất xóa mật khẩu.'],
  '操作尚未完成，可以继续重试。': ['The operation is unfinished. You can retry.','操作は未完了です。再試行できます。','작업이 완료되지 않았습니다. 다시 시도할 수 있습니다.','Der Vorgang ist noch nicht abgeschlossen. Erneut versuchen.','La operación no ha terminado. Puedes reintentar.','Операция не завершена. Можно повторить попытку.','Thao tác chưa hoàn tất. Bạn có thể thử lại.'],
  '未完成的密码移除': ['Unfinished password removals','未完了のパスワード削除','미완료 비밀번호 제거','Offene Passwortentfernungen','Eliminaciones de contraseñas pendientes','Незавершённые удаления паролей','Các lần xóa mật khẩu chưa hoàn tất'],
  '正在核对操作结果…': ['Checking the operation result…','操作結果を確認しています…','작업 결과 확인 중…','Vorgangsergebnis wird geprüft…','Comprobando el resultado…','Проверка результата операции…','Đang kiểm tra kết quả thao tác…'],
  '移除 {0} 个密码': ['Remove {0} passwords','パスワード {0} 件を削除','비밀번호 {0}개 제거','{0} Passwörter entfernen','Eliminar {0} contraseñas','Удаление паролей: {0}','Xóa {0} mật khẩu'],
  '请先解锁密码库以继续。': ['Unlock the vault to continue.','続行するには保管庫をロック解除してください。','계속하려면 보관함 잠금을 해제하세요.','Zum Fortfahren Tresor entsperren.','Desbloquea la bóveda para continuar.','Разблокируйте хранилище для продолжения.','Mở khóa kho để tiếp tục.'],
  '此来源的移除操作暂不受支持，原始内容已保留。': ['Removal is not supported for this source yet. Original content is preserved.','この保存先の削除にはまだ対応していません。元の内容は保持されています。','이 소스는 아직 제거를 지원하지 않습니다. 원본 내용은 보존됩니다.','Entfernen wird für diese Quelle noch nicht unterstützt. Ursprüngliche Inhalte bleiben erhalten.','Esta fuente aún no permite eliminar. Se conserva el contenido original.','Удаление для этого источника пока не поддерживается. Исходные данные сохранены.','Nguồn này chưa hỗ trợ xóa. Nội dung gốc được giữ lại.'],
  '取消这次移除': ['Cancel this removal','この削除を取り消す','이번 제거 취소','Diese Entfernung abbrechen','Cancelar esta eliminación','Отменить это удаление','Hủy lần xóa này'],
  '确认移除密码': ['Confirm password removal','パスワード削除の確認','비밀번호 제거 확인','Passwortentfernung bestätigen','Confirmar eliminación de contraseñas','Подтверждение удаления паролей','Xác nhận xóa mật khẩu'],
  '保留 {0} 个密码': ['Keep {0} passwords','パスワード {0} 件を保持','비밀번호 {0}개 유지','{0} Passwörter behalten','Conservar {0} contraseñas','Останется паролей: {0}','Giữ lại {0} mật khẩu'],
  '备注、共享内容与附件会保留。': ['Notes, shared content and attachments will be preserved.','メモ、共有内容、添付ファイルは保持されます。','메모, 공유 내용 및 첨부 파일은 유지됩니다.','Notizen, gemeinsame Inhalte und Anhänge bleiben erhalten.','Se conservarán las notas, el contenido compartido y los adjuntos.','Заметки, общие данные и вложения будут сохранены.','Ghi chú, nội dung chung và tệp đính kèm sẽ được giữ lại.'],
  '保存后会同步到此项目的密码库。': ['Changes will sync to this project’s vault after saving.','保存後、このプロジェクトの保管庫に同期されます。','저장 후 이 프로젝트의 보관함과 동기화됩니다.','Änderungen werden nach dem Speichern mit dem Tresor dieses Projekts synchronisiert.','Los cambios se sincronizarán con la bóveda del proyecto al guardar.','После сохранения изменения будут синхронизированы с хранилищем проекта.','Sau khi lưu, thay đổi sẽ được đồng bộ với kho của dự án này.'],
  '这次保存已提交。重试会核对同一次操作，请勿重复新建移除。': ['This save was submitted. Retrying checks the same operation; do not start another removal.','保存を送信しました。再試行では同じ操作を確認します。別の削除を開始しないでください。','저장을 요청했습니다. 재시도하면 같은 작업을 확인합니다. 새 제거 작업을 시작하지 마세요.','Speichern wurde angefordert. Ein erneuter Versuch prüft denselben Vorgang; keine weitere Entfernung starten.','Se ha solicitado guardar. Reintentar comprobará la misma operación; no inicies otra eliminación.','Запрос сохранения отправлен. Повторная попытка проверит ту же операцию; не начинайте новое удаление.','Đã gửi yêu cầu lưu. Thử lại sẽ kiểm tra cùng thao tác; đừng bắt đầu lần xóa khác.'],
  '查看待处理操作': ['View pending operations','保留中の操作を表示','대기 중 작업 보기','Offene Vorgänge anzeigen','Ver operaciones pendientes','Посмотреть ожидающие операции','Xem thao tác đang chờ'],
  '返回编辑': ['Back to editing','編集に戻る','편집으로 돌아가기','Zurück zur Bearbeitung','Volver a editar','Вернуться к редактированию','Quay lại chỉnh sửa'],
  '重试这次保存': ['Retry this save','この保存を再試行','이번 저장 재시도','Speichern erneut versuchen','Reintentar este guardado','Повторить это сохранение','Thử lưu lại lần này'],
  '确认移除并保存': ['Confirm removal and save','削除を確認して保存','제거 확인 및 저장','Entfernen bestätigen und speichern','Confirmar eliminación y guardar','Подтвердить удаление и сохранить','Xác nhận xóa và lưu'],
  '查看移除并保存': ['Review removal and save','削除内容を確認して保存','제거 검토 및 저장','Entfernung prüfen und speichern','Revisar eliminación y guardar','Проверить удаление и сохранить','Xem lại việc xóa và lưu']
};
for (const [index, locale] of ['en','ja','ko','de','es','ru','vi'].entries()) {
  const path = new URL(locale === 'en' ? '../src/i18n/ui-en.json' : `../public/locales/ui-${locale}.json`, import.meta.url);
  const data = JSON.parse(await readFile(path, 'utf8'));
  for (const [key, values] of Object.entries(entries)) data[key] = values[index];
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}
