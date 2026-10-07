import { expect, it } from 'vitest';
import { bitmapIconDataUrl, KEEPASS_CUSTOM_ICON_TYPE, MAX_ICON_BYTES } from './bitmap-icon';
import { customIconProjection } from './custom-icon';
import { bytesToBase64 } from '../security/encoding';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
it('projects native PNG bytes without exposing a file or network path', () => {
  expect(bitmapIconDataUrl(png)).toBe(`data:image/png;base64,${png}`);
  expect(customIconProjection({ customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: png })).toEqual({ customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue: png });
});
it.each(['bad!', btoa('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), btoa('<html>unsafe</html>'), 'file:///private/image.png', 'https://example.test/private.png'])('does not expose unsupported or active content %s', value => {
  expect(bitmapIconDataUrl(value)).toBeUndefined();
  expect(customIconProjection({customIconType: KEEPASS_CUSTOM_ICON_TYPE, customIconValue:value}).customIconValue).toBeUndefined();
});
it('bounds decoded binary size', () => {
  expect(bitmapIconDataUrl(bytesToBase64(new Uint8Array(MAX_ICON_BYTES + 1)))).toBeUndefined();
});
