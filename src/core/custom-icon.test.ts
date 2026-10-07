import { expect, it } from 'vitest';
import { brandIconPath, customIconProjection, normalizeEmojiIcon } from './custom-icon';
import { decodeMdbx2Object, encodeMdbx2Object } from '../providers/mdbx2/mdbx2-item-codec';
it('accepts one registered emoji sequence and rejects text, multiple emoji and invented joins', () => {
  for(const value of ['🔑','👩🏽‍💻','🇨🇳','1️⃣','❤️']) expect(normalizeEmojiIcon(` ${value} `)).toBe(value);
  for(const value of ['','hello','🔑🔐','a','1','🔑\u200d💳','<img>','\n🔑\n🔐']) expect(normalizeEmojiIcon(value)).toBeUndefined();
});
it('uses only catalog-backed local brand paths and never sends an uploaded filename to the popup', () => {
  expect(brandIconPath('github')).toMatch(/^brand-icons\/.+\.png$/);
  for(const value of ['../secrets','https://example.com','data:image/png;base64,AA','missing']) expect(brandIconPath(value)).toBeUndefined();
  expect(customIconProjection({customIconType:'UPLOADED',customIconValue:'private-file.png'}).customIconValue).toBeUndefined();
  expect(customIconProjection({customIconType:'EMOJI',customIconValue:'🔑'})).toEqual({customIconType:'EMOJI',customIconValue:'🔑'});
});
it('preserves an unedited native icon payload and writes an explicit replacement', () => {
  const payload={kind:'password',monica_entry_id:'password:icon',custom_icon_type:'UPLOADED',custom_icon_value:'android-private.png',custom_icon_updated_at:123,future_icon:{preserved:true}};
  const record={objectId:'icon-object',collectionId:'icon-folder',objectTypeId:'login',title:'Icon',payloadJson:JSON.stringify(payload),payloadSchemaVersion:1,deleted:false};
  const original=decodeMdbx2Object(record,{headCommitId:'head',updatedAt:new Date().toISOString()},'provider').item!;
  expect(original).toMatchObject({customIconType:'UPLOADED',customIconValue:'android-private.png',customIconUpdatedAt:123});
  expect(JSON.parse(encodeMdbx2Object({...original,title:'Renamed'},payload,original)!.payloadJson)).toEqual(payload);
  if(original.kind!=='login')throw new Error('Expected login');
  const changed=JSON.parse(encodeMdbx2Object({...original,customIconType:'EMOJI',customIconValue:'🔑',customIconUpdatedAt:456},payload,original)!.payloadJson);
  expect(changed).toMatchObject({custom_icon_type:'EMOJI',custom_icon_value:'🔑',custom_icon_updated_at:456,future_icon:{preserved:true}});
});
