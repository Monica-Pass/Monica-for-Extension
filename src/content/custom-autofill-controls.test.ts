import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { fillCredential, type FillCredentialInput } from './dom';
import { loginFieldRole } from './login-field-role';
import { websiteAutofillFields } from '../autofill/custom-fields';

function documentFor(extra: string) {
  const dom = new JSDOM(`<form id="login"><input autocomplete="username" id="username"><input type="password" autocomplete="current-password">${extra}</form>`,
    { url: 'https://controls.example.test/login', pretendToBeVisual: true });
  for (const control of dom.window.document.querySelectorAll<HTMLElement>('input,textarea,select')) {
    control.getBoundingClientRect = () => ({ x: 0, y: 0, width: 240, height: 44, top: 0, right: 240, bottom: 44, left: 0, toJSON() {} });
  }
  return dom.window.document;
}
const credential = (customFields: unknown[]): FillCredentialInput => ({ username: 'account', password: 'secret', customFields } as FillCredentialInput);
const field = (name: string, value: string, fieldType = 'TEXT') => ({ name, value, fieldType });

describe('custom credential form controls', () => {
  it('sets boolean checked state in both directions without changing submitted checkbox value or clicking', () => {
    const document = documentFor('<input type="checkbox" name="remember" value="server-token"><input type="checkbox" name="notifications" value="enabled" checked>');
    const remember = document.querySelector<HTMLInputElement>('[name=remember]')!;
    const notifications = document.querySelector<HTMLInputElement>('[name=notifications]')!;
    const events: string[] = [];
    remember.addEventListener('click', () => events.push('click'));
    remember.addEventListener('input', () => events.push(`input:${remember.checked}`));
    remember.addEventListener('change', () => events.push(`change:${remember.checked}`));
    expect(fillCredential(credential([field('remember', 'true', 'BOOLEAN'), { name: 'notifications', value: 'false', type: 'boolean' }]), document))
      .toMatchObject({ ok: true, filledCustomFields: 2 });
    expect([remember.checked, notifications.checked]).toEqual([true, false]);
    expect([remember.value, notifications.value]).toEqual(['server-token', 'enabled']);
    expect(events).toEqual(['input:true', 'change:true']);
  });

  it('fills multiline text and unique dropdown values or labels and emits native input/change events', () => {
    const document = documentFor('<textarea aria-label="Recovery note"></textarea><select name="tenant"><option value="">Choose</option><option value="team-id">Team A</option></select>');
    const text = document.querySelector('textarea')!; const select = document.querySelector('select')!;
    const events: string[] = [];
    for (const control of [text, select]) for (const name of ['input', 'change']) control.addEventListener(name, () => events.push(`${control.tagName}:${name}`));
    const fields = [field('Recovery note', 'line 1\r\n历史 line 2', 'HIDDEN'), field('tenant', 'Team A')];
    expect(fillCredential(credential(fields), document)).toMatchObject({ ok: true, filledCustomFields: 2 });
    expect(text.value).toBe('line 1\n历史 line 2'); expect(select.value).toBe('team-id');
    expect(fields[0].value).toBe('line 1\r\n历史 line 2');
    expect(events).toEqual(['TEXTAREA:input', 'TEXTAREA:change', 'SELECT:input', 'SELECT:change']);
    select.selectedIndex = 0;
    expect(fillCredential(credential([field('tenant', 'team-id')]), document)).toMatchObject({ filledCustomFields: 1 });
    expect(select.selectedIndex).toBe(1);
  });

  it('preserves field types in the minimal website projection and removes internal fields', () => {
    expect(websiteAutofillFields([
      { name: 'toggle', value: 'false', fieldType: 'BOOLEAN', protected: true },
      { name: 'legacy', value: 'true', type: 'boolean', protected: false },
      { name: 'monica.content.credential', value: 'internal', protected: true },
    ])).toEqual([{ name: 'toggle', value: 'false', fieldType: 'BOOLEAN' }, { name: 'legacy', value: 'true', type: 'boolean' }]);
  });

  it('uses form-associated custom controls outside the form without crossing into another form', () => {
    const document = documentFor('');
    document.body.insertAdjacentHTML('beforeend', '<textarea name="note" form="login"></textarea><form id="other"><textarea name="note"></textarea></form>');
    for (const control of document.querySelectorAll('textarea')) control.getBoundingClientRect = () => ({ width: 200, height: 50 } as DOMRect);
    expect(fillCredential(credential([field('note', 'owned by the login form')]), document)).toMatchObject({ ok: true, filledCustomFields: 1 });
    expect(document.querySelector<HTMLTextAreaElement>('textarea[form]')!.value).toBe('owned by the login form');
    expect(document.querySelector<HTMLTextAreaElement>('#other textarea')!.value).toBe('');
  });

  it('leaves ambiguous/disabled/multiple selects, malformed booleans and plain checkbox text alone', () => {
    const document = documentFor('<select name="ambiguous"><option value="a">Same</option><option value="b">Same</option></select><select name="disabled"><option value="a">A</option><optgroup disabled><option value="b">B</option></optgroup></select><select name="multiple" multiple><option value="b">B</option></select><input name="bad" type="checkbox" value="unchanged"><input name="plain" type="checkbox" value="unchanged">');
    const before = document.querySelector('form')!.innerHTML;
    expect(fillCredential({ customFields: credential([field('ambiguous', 'Same'), field('disabled', 'b'), field('multiple', 'b'), field('bad', 'yes', 'BOOLEAN'), field('plain', 'true')]).customFields }, document))
      .toMatchObject({ ok: false });
    expect(document.querySelector('form')!.innerHTML).toBe(before);
    expect([...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map(input => input.checked)).toEqual([false, false]);
  });

  it('never fills action/file/hidden/radio/new-password controls or disabled-fieldset descendants', () => {
    const document = documentFor('<input name="upload" type="file"><input name="submit" type="submit" value="Send"><input name="invisible" type="hidden"><input name="radio" type="radio"><input name="new" type="password" autocomplete="new-password"><fieldset disabled><input name="tenant"></fieldset>');
    expect(() => fillCredential(credential(['upload', 'submit', 'invisible', 'radio', 'new', 'tenant'].map(name => field(name, 'must-not-fill'))), document)).not.toThrow();
    for (const name of ['upload', 'invisible', 'new', 'tenant']) expect(document.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('[name=submit]')!.value).toBe('Send');
    expect(document.querySelector<HTMLInputElement>('[name=radio]')!.checked).toBe(false);
  });

  it.each(['checkbox','radio','file','submit','button','reset','hidden','image'])('does not classify a %s control as a login credential', type => {
    const document = documentFor(`<input type="${type}" name="username" autocomplete="username">`);
    expect(loginFieldRole(document.querySelector<HTMLInputElement>(`[type="${type}"]`)!, document)).toBe('other');
  });

  it('stops before later secrets when a checkbox handler replaces the next textarea', () => {
    const document = documentFor('<input type="checkbox" name="remember"><textarea name="recovery"></textarea>');
    const before = document.querySelector('textarea')!;
    document.querySelector('[name=remember]')!.addEventListener('input', () => before.replaceWith(before.cloneNode()));
    const result = fillCredential(credential([field('remember', 'true', 'BOOLEAN'), field('recovery', 'private recovery note', 'HIDDEN')]), document);
    expect(result).toMatchObject({ ok: false }); expect(before.value).toBe(''); expect(document.querySelector('textarea')!.value).toBe('');
  });

  it('refuses a dropdown whose options changed during a preceding native input event', () => {
    const document = documentFor('<select name="tenant"><option value="">Choose</option><option value="team">Team</option></select>');
    document.querySelector('#username')!.addEventListener('input', () => { document.querySelectorAll('option')[1].text = 'Changed account'; });
    expect(fillCredential(credential([field('tenant', 'team')]), document)).toMatchObject({ ok: false, filledCustomFields: 0 });
    expect(document.querySelector('select')!.value).toBe('');
  });

  it('keeps internal project carriers out of every custom-control type', () => {
    const document = documentFor('<textarea name="monica.content.credential"></textarea><select name="monica_gpg_private"><option value="">Choose</option><option value="private">Private</option></select>');
    expect(fillCredential(credential([field('monica.content.credential', 'private'), field('monica_gpg_private', 'private')]), document)).toMatchObject({ ok: true, filledCustomFields: 0 });
    expect(document.querySelector('textarea')!.value).toBe(''); expect(document.querySelector('select')!.value).toBe('');
  });
});
