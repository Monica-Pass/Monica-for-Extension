import catalog from './brand-icon-catalog.json';
import { bitmapIconDataUrl, KEEPASS_CUSTOM_ICON_TYPE } from './bitmap-icon';
export const brandIcons = catalog;
export const quickEmojiIcons = ['🔑','🔐','💳','🏦','🎁','🛒','📧','📱','🎮','🎵','🎬','📚','🏠','🚗','✈️','🏥','💼','🏫','☁️','🌐','⭐','❤️','🍔','🐱'];
const bySlug = new Map(catalog.map(icon => [icon.slug, icon]));
const emojiPattern = new RegExp('^\\p{RGI_Emoji}$', 'v');
export function normalizeEmojiIcon(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && value.length <= 32 && emojiPattern.test(value) ? value : undefined;
}
export function brandIconPath(slug: string | undefined, dark = false): string | undefined {
  const entry = slug ? bySlug.get(slug) : undefined;
  if (!entry) return undefined;
  const variant = entry as {light?:string;dark?:string};
  const file = dark ? variant.dark || variant.light : variant.light || variant.dark;
  return file ? `brand-icons/${file}` : undefined;
}
export function customIconProjection(item?: { customIconType?: string; customIconValue?: string }) {
  if (item?.customIconType === KEEPASS_CUSTOM_ICON_TYPE && bitmapIconDataUrl(item.customIconValue)) return { customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: item.customIconValue };
  if (item?.customIconType === 'EMOJI') return { customIconType: 'EMOJI', customIconValue: normalizeEmojiIcon(item.customIconValue) };
  if (item?.customIconType === 'SIMPLE_ICON' && brandIconPath(item.customIconValue)) return { customIconType: 'SIMPLE_ICON', customIconValue: item.customIconValue };
  return { customIconType: item?.customIconType ? 'NONE' : undefined, customIconValue: undefined };
}
