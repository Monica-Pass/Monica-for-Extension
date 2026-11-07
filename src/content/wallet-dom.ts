import type { WalletFieldName, WalletFillKind, WalletFillPayload, WalletFillResult } from "../runtime/messages";
import { elementByIdInRoot, queryComposedAll } from "./composed-dom";
import { walletPhoneSegment, walletSelectOption } from './wallet-values';

type WalletControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface WalletField {
  element: WalletControl;
  name: WalletFieldName;
  kinds: WalletFillKind[];
  token?: string;
  section: string;
  addressKind: string;
  contact: string;
}

const AUTOCOMPLETE_FIELDS: Record<string, WalletFieldName> = {
  name: "fullName",
  "given-name": "firstName",
  "additional-name": "middleName",
  "family-name": "lastName",
  bday: "birthDate",
  organization: "company",
  "street-address": "streetAddress",
  "address-line1": "streetAddress",
  "address-line2": "apartment",
  "address-line3": "addressLine3",
  "address-level3": "district",
  "address-level2": "city",
  "address-level1": "stateProvince",
  "postal-code": "postalCode",
  country: "country",
  "country-name": "country",
  tel: "phone",
  'tel-country-code': 'phone', 'tel-national': 'phone', 'tel-area-code': 'phone',
  'tel-local': 'phone', 'tel-local-prefix': 'phone', 'tel-local-suffix': 'phone', 'tel-extension': 'phone',
  email: "email",
  "cc-name": "cardholderName",
  'cc-given-name': 'cardholderFirstName', 'cc-additional-name': 'cardholderMiddleName', 'cc-family-name': 'cardholderLastName',
  "cc-number": "cardNumber",
  "cc-exp-month": "cardExpiryMonth",
  "cc-exp-year": "cardExpiryYear",
  "cc-exp": "cardExpiry",
  "cc-csc": "cardSecurityCode",
  "cc-type": "cardBrand",
  "transaction-currency": "currency"
};

const FIELD_KINDS: Record<WalletFieldName, WalletFillKind[]> = {
  fullName: ["identity", "billing-address"], firstName: ["identity", "billing-address"], middleName: ["identity", "billing-address"], lastName: ["identity", "billing-address"],
  addressLine3: ['identity', 'billing-address'], district: ['identity', 'billing-address'],
  homeEmail: ['identity', 'billing-address'], homePhone: ['identity', 'billing-address'], workEmail: ['identity', 'billing-address'], workPhone: ['identity', 'billing-address'],
  cardholderFirstName: ['card'], cardholderMiddleName: ['card'], cardholderLastName: ['card'],
  birthDate: ["identity"], nationality: ["identity"], documentNumber: ["identity"], documentType: ["identity"],
  documentIssuedDate: ["identity"], documentExpiryDate: ["identity"], documentIssuedBy: ["identity"],
  passportNumber: ["identity"], licenseNumber: ["identity"], ssn: ["identity"], company: ["identity", "billing-address"],
  streetAddress: ["identity", "billing-address"], apartment: ["identity", "billing-address"], city: ["identity", "billing-address"],
  stateProvince: ["identity", "billing-address"], postalCode: ["identity", "billing-address"], country: ["identity", "billing-address"],
  phone: ["identity", "billing-address", "payment-account"], email: ["identity", "billing-address", "payment-account"],
  cardholderName: ["card"], cardNumber: ["card"], cardExpiryMonth: ["card"], cardExpiryYear: ["card"], cardExpiry: ["card"],
  cardSecurityCode: ["card"], cardBrand: ["card"], cardPin: ["card"], paymentProvider: ["card", "payment-account"], paymentAccountName: ["payment-account"],
  paymentAccountHolder: ["payment-account"], paymentUsername: ["payment-account"], paymentAccountId: ["payment-account"],
  paymentAccountNumber: ["card", "payment-account"], routingNumber: ["card", "payment-account"], iban: ["card", "payment-account"], swiftBic: ["card", "payment-account"],
  branchCode: ["card"], currency: ["card", "payment-account"]
};

const HEURISTICS: Array<[WalletFieldName, RegExp]> = [
  ['addressLine3', /^(addressline3|address3|地址第三行)$/], ['district', /^(district|county|区县)$/],
  ['homeEmail', /^(homeemail|家庭邮箱)$/], ['homePhone', /^(homephone|家庭电话)$/],
  ['workEmail', /^(workemail|工作邮箱)$/], ['workPhone', /^(workphone|工作电话)$/],
  ['cardholderFirstName', /^(cardholderfirstname|ccgivenname|持卡人名)$/],
  ['cardholderMiddleName', /^(cardholdermiddlename|ccadditionalname|持卡人中间名)$/],
  ['cardholderLastName', /^(cardholderlastname|ccfamilyname|持卡人姓)$/],
  ["cardSecurityCode", /^(cvv|cvc|cardsecuritycode|cardverificationcode|银行卡安全码|信用卡安全码|卡片安全码)$/],
  ["cardPin", /^(cardpin|creditcardpin|bankcardpin|银行卡pin|信用卡pin|卡片pin)$/],
  ["cardExpiryMonth", /^(card|cc)?expir(y|ation)?month$/],
  ["cardExpiryYear", /^(card|cc)?expir(y|ation)?year$/],
  ["cardExpiry", /^(card|cc)?expir(y|ation)?(date)?$|^(银行卡|信用卡|卡片)(有效期|到期日|到期日期)$/],
  ["cardholderName", /^(cardholder|cardholdername|nameoncard|持卡人|持卡人姓名|持有人姓名)$/],
  ["cardNumber", /^(card|cc)(number|no)$|^(银行卡号|信用卡号|借记卡号|卡号)$/],
  ["passportNumber", /^(passport|passportnumber|护照号|护照号码)$/],
  ["licenseNumber", /^(driverslicen[cs]enumber|licen[cs]enumber|驾照号|驾驶证号|驾驶证号码)$/],
  ["ssn", /^(socialsecuritynumber|ssn|社保号|社会保障号码)$/],
  ["documentNumber", /^(documentnumber|identitynumber|idcardnumber|证件号|证件号码|身份证号|身份证号码)$/],
  ["documentType", /^(documenttype|identitytype|idtype|证件类型)$/],
  ["documentIssuedDate", /^(document)?(issuedate|issueddate|dateofissue)$|^(签发日期|签发日)$/],
  ["documentExpiryDate", /^(document|passport|license)?(expirydate|expirationdate|dateofexpiry)$|^(证件|护照|驾驶证)?(到期日期|有效期至)$/],
  ["documentIssuedBy", /^(issuedby|issuingauthority|签发机关)$/],
  ["birthDate", /^(birthdate|dateofbirth|dob|出生日期|出生年月日)$/],
  ["nationality", /^(nationality|国籍)$/],
  ["routingNumber", /^(routing|routingnumber|abarn|路由号码|银行路由号码)$/],
  ["branchCode", /^(branchcode|bankbranchcode|分行代码|银行分行代码)$/],
  ["swiftBic", /^(swift|swiftbic|bic|biccode|swift代码|swift码|银行识别码)$/],
  ["iban", /^(iban(number)?|国际银行账号|国际银行账户)$/],
  ["paymentAccountId", /^(payment)?accountid$|^(支付账户标识|账户标识)$/],
  ["paymentAccountNumber", /^(bank|payment)accountnumber$|^(银行账号|银行账户号码|支付账户号码)$/],
  ["paymentAccountHolder", /^(account)?holder(name)?$|^(账户持有人|账户持有人姓名)$/],
  ["paymentProvider", /^(payment)?provider$|^(支付机构|支付服务商|银行名称)$/],
  ["paymentAccountName", /^paymentaccountname$|^(支付账户名称|账户名称)$/],
  ["paymentUsername", /^paymentusername$|^支付用户名$/],
  ["firstName", /^(firstname|givenname|名)$/], ["middleName", /^(middlename|additionalname|中间名)$/], ["lastName", /^(lastname|surname|familyname|姓)$/],
  ["fullName", /^(fullname|recipientname|姓名|收件人姓名|收货人姓名)$/], ["company", /^(company|organization|公司|公司名称|单位|单位名称)$/],
  ["streetAddress", /^(streetaddress|addressline1|address1|地址|街道地址|详细地址|收货地址)$/], ["apartment", /^(apartment|addressline2|address2|公寓|房间号|单元号)$/],
  ["city", /^(city|town|城市|市)$/], ["stateProvince", /^(state|province|stateprovince|省|省份|州|州省)$/], ["postalCode", /^(postalcode|postcode|zipcode|zip|邮编|邮政编码)$/],
  ["country", /^(country|countryname|国家|国家或地区|国家地区)$/], ["phone", /^(phone|phonenumber|telephone|tel|电话|电话号码|手机|手机号|手机号码)$/], ["email", /^(email|emailaddress|邮箱|电子邮箱)$/],
  ["currency", /^(currency|transactioncurrency|币种|货币)$/]
];

export function scanWalletKinds(rootDocument: Document = document): WalletFillKind[] {
  const found = new Set(findWalletFields(rootDocument).flatMap((field) => field.kinds));
  return (["identity", "billing-address", "card", "payment-account"] as WalletFillKind[]).filter((kind) => found.has(kind));
}

export function fillWallet(payload: WalletFillPayload, rootDocument: Document = document): { ok: boolean; error?: string } & WalletFillResult {
  const filledFields: WalletFieldName[] = [];
  for (const field of scopedWalletFields(findWalletFields(rootDocument).filter(f => f.kinds.includes(payload.kind)), rootDocument)) {
    let value = payload.fields[field.name];
    if (field.token === 'street-address') value = [payload.fields.streetAddress, payload.fields.apartment, payload.fields.addressLine3].filter(Boolean).join('\n');
    if (value && field.token?.startsWith('tel-')) value = walletPhoneSegment(value, payload.fields.country, field.token, rootDocument.documentElement.lang || 'en');
    if (!value || !field.element.isConnected || !visibleControl(field.element) || !setControlValue(field.element, value, field.name)) continue;
    filledFields.push(field.name);
  }
  if (!filledFields.length) return { ok: false, error: "当前页面没有与此项目对应的安全可填写字段。", filledCount: 0, filledFields: [] };
  return { ok: true, filledCount: filledFields.length, filledFields: [...new Set(filledFields)] };
}

function findWalletFields(rootDocument: Document): WalletField[] {
  return queryComposedAll<WalletControl>(rootDocument, "input,select,textarea").flatMap((element) => {
    if (!visibleControl(element)) return [];
    const parsed = describeWalletField(element);
    return parsed ? [{ element, ...parsed, kinds: FIELD_KINDS[parsed.name] }] : [];
  });
}

export function walletFieldName(element: WalletControl): WalletFieldName | undefined {
  return describeWalletField(element)?.name;
}

function describeWalletField(element: WalletControl): Omit<WalletField, 'element' | 'kinds'> | undefined {
  const tokens = (element.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  let section = '', addressKind = '', contact = '', token: string | undefined, name: WalletFieldName | undefined;
  if (tokens.length && !['on', 'off'].includes(tokens[0])) {
    if (tokens[0]?.startsWith('section-') && tokens[0].length > 8) section = tokens.shift()!;
    if (['shipping', 'billing'].includes(tokens[0])) addressKind = tokens.shift()!;
    if (['home', 'work', 'mobile', 'fax', 'pager'].includes(tokens[0])) contact = tokens.shift()!;
    token = tokens.shift();
    if (tokens.length || !token || !AUTOCOMPLETE_FIELDS[token] || contact && token !== 'email' && !token.startsWith('tel')) return;
    if (contact && contact !== 'home' && contact !== 'work') return; // No independent stored value for other contact groups.
    name = AUTOCOMPLETE_FIELDS[token];
    if (contact) name = `${contact}${name === 'email' ? 'Email' : 'Phone'}` as WalletFieldName;
  } else name = heuristicField(element);
  if (!name) return;
  if (element instanceof element.ownerDocument.defaultView!.HTMLInputElement) {
    if (element.type === 'tel' && !['phone', 'homePhone', 'workPhone'].includes(name)) return;
    if (element.type === 'email' && !['email', 'homeEmail', 'workEmail'].includes(name)) return;
  }
  if (!contact && /^(home|work)(Email|Phone)$/.test(name)) contact = name.startsWith('home') ? 'home' : 'work';
  return { name, token, section, addressKind, contact };
}

const lastFocused = new WeakMap<Document, Element>();
export function installWalletFocusTracking(rootDocument: Document = document): void {
  rootDocument.addEventListener('focusin', event => {
    const element = event.composedPath()[0];
    if (element instanceof rootDocument.defaultView!.Element) lastFocused.set(rootDocument, element);
  }, true);
}
function scopedWalletFields(fields: WalletField[], doc: Document): WalletField[] {
  let focus = doc.activeElement;
  while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
  if (!focus || focus === doc.body || focus === doc.documentElement) focus = lastFocused.get(doc) ?? null;
  const anchor = fields.find(f => f.element === focus);
  const groups: WalletField[][] = [];
  for (const field of fields) {
    let group = [...groups].reverse().find(g => g[0].element.form === field.element.form && g[0].element.getRootNode() === field.element.getRootNode()
      && g[0].section === field.section && g[0].addressKind === field.addressKind);
    // Repeated unmarked blocks are separated in document order.
    if (group?.some(f => f.name === field.name && f.token === field.token)) group = undefined;
    if (!group) { group = []; groups.push(group); }
    group.push(field);
  }
  const selected = anchor ? groups.find(g => g.includes(anchor)) : groups.length === 1 && (!focus || focus === doc.body || focus === doc.documentElement) ? groups[0] : undefined;
  if (!selected) return [];
  return anchor?.contact ? selected.filter(f => f.contact === anchor.contact) : selected;
}

function heuristicField(element: WalletControl): WalletFieldName | undefined {
  const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map((id) => elementByIdInRoot(element, id)?.textContent);
  const hints = [element.id, element.getAttribute("name"), element.getAttribute("aria-label"), element.getAttribute("placeholder"), ...labelledBy, ...Array.from(element.labels || []).map((label) => label.textContent)]
    .map((value) => normalizeHint(value || "")).filter(Boolean);
  return HEURISTICS.find(([, pattern]) => hints.some((hint) => pattern.test(hint)))?.[0];
}

function normalizeHint(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function visibleControl(element: WalletControl): boolean {
  if (element instanceof element.ownerDocument.defaultView!.HTMLSelectElement && element.multiple) return false;
  if (element.disabled || element instanceof element.ownerDocument.defaultView!.HTMLInputElement && (element.readOnly || /^(hidden|password|file|submit|button|checkbox|radio)$/i.test(element.type))) return false;
  if (element instanceof element.ownerDocument.defaultView!.HTMLTextAreaElement && element.readOnly) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style?.display !== "none" && style?.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function setControlValue(element: WalletControl, requestedValue: string, name: WalletFieldName): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  let value = requestedValue;
  let prototype: object;
  if (element instanceof view.HTMLSelectElement) {
    const option = walletSelectOption(element, name, requestedValue);
    if (!option) return false;
    value = option.value;
    prototype = view.HTMLSelectElement.prototype;
  } else if (element instanceof view.HTMLTextAreaElement) {
    prototype = view.HTMLTextAreaElement.prototype;
  } else {
    value = value.replace(/\r?\n/g, ', ');
    prototype = view.HTMLInputElement.prototype;
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) return false;
  try { descriptor.set.call(element, value); } catch { return false; }
  element.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new view.Event("change", { bubbles: true }));
  return true;
}
