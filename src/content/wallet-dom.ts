import type { WalletFieldName, WalletFillKind, WalletFillPayload, WalletFillResult } from "../runtime/messages";
import { elementByIdInRoot, queryComposedAll } from "./composed-dom";

type WalletControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface WalletField {
  element: WalletControl;
  name: WalletFieldName;
  kinds: WalletFillKind[];
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
  "address-level2": "city",
  "address-level1": "stateProvince",
  "postal-code": "postalCode",
  country: "country",
  "country-name": "country",
  tel: "phone",
  email: "email",
  "cc-name": "cardholderName",
  "cc-number": "cardNumber",
  "cc-exp-month": "cardExpiryMonth",
  "cc-exp-year": "cardExpiryYear",
  "cc-exp": "cardExpiry",
  "cc-csc": "cardSecurityCode",
  "cc-type": "cardBrand",
  "transaction-currency": "currency"
};

const FIELD_KINDS: Record<WalletFieldName, WalletFillKind[]> = {
  fullName: ["identity", "billing-address"], firstName: ["identity"], middleName: ["identity"], lastName: ["identity"],
  birthDate: ["identity"], nationality: ["identity"], documentNumber: ["identity"], company: ["billing-address"],
  streetAddress: ["identity", "billing-address"], apartment: ["identity", "billing-address"], city: ["identity", "billing-address"],
  stateProvince: ["identity", "billing-address"], postalCode: ["identity", "billing-address"], country: ["identity", "billing-address"],
  phone: ["identity", "billing-address", "payment-account"], email: ["identity", "billing-address", "payment-account"],
  cardholderName: ["card"], cardNumber: ["card"], cardExpiryMonth: ["card"], cardExpiryYear: ["card"], cardExpiry: ["card"],
  cardSecurityCode: ["card"], cardBrand: ["card"], paymentProvider: ["payment-account"], paymentAccountName: ["payment-account"],
  paymentAccountHolder: ["payment-account"], paymentUsername: ["payment-account"], paymentAccountId: ["payment-account"],
  paymentAccountNumber: ["payment-account"], routingNumber: ["payment-account"], iban: ["payment-account"], swiftBic: ["payment-account"],
  currency: ["payment-account"]
};

const HEURISTICS: Array<[WalletFieldName, RegExp]> = [
  ["cardSecurityCode", /^(cvv|cvc|cardsecuritycode|cardverificationcode|银行卡安全码|信用卡安全码|卡片安全码)$/],
  ["cardExpiryMonth", /^(card|cc)?expir(y|ation)?month$/],
  ["cardExpiryYear", /^(card|cc)?expir(y|ation)?year$/],
  ["cardExpiry", /^(card|cc)?expir(y|ation)?(date)?$|^(银行卡|信用卡|卡片)(有效期|到期日|到期日期)$/],
  ["cardholderName", /^(cardholder|cardholdername|nameoncard|持卡人|持卡人姓名|持有人姓名)$/],
  ["cardNumber", /^(card|cc)(number|no)$|^(银行卡号|信用卡号|借记卡号|卡号)$/],
  ["documentNumber", /^(passport|passportnumber|documentnumber|identitynumber|idcardnumber|driverslicen[cs]enumber|socialsecuritynumber|ssn|证件号|证件号码|身份证号|身份证号码|护照号|护照号码|驾照号|驾驶证号|社保号|社会保障号码)$/],
  ["birthDate", /^(birthdate|dateofbirth|dob|出生日期|出生年月日)$/],
  ["nationality", /^(nationality|国籍)$/],
  ["routingNumber", /^(routing|routingnumber|abarn|路由号码|银行路由号码)$/],
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
  for (const field of findWalletFields(rootDocument)) {
    if (!field.kinds.includes(payload.kind)) continue;
    const value = payload.fields[field.name];
    if (!value || !setControlValue(field.element, value)) continue;
    filledFields.push(field.name);
  }
  if (!filledFields.length) return { ok: false, error: "当前页面没有与此项目对应的安全可填写字段。", filledCount: 0, filledFields: [] };
  return { ok: true, filledCount: filledFields.length, filledFields: [...new Set(filledFields)] };
}

function findWalletFields(rootDocument: Document): WalletField[] {
  return queryComposedAll<WalletControl>(rootDocument, "input,select,textarea").flatMap((element) => {
    if (!visibleControl(element)) return [];
    const autocomplete = element.autocomplete.toLowerCase().split(/\s+/).reverse().find((token) => AUTOCOMPLETE_FIELDS[token]);
    const name = autocomplete ? AUTOCOMPLETE_FIELDS[autocomplete] : heuristicField(element);
    return name ? [{ element, name, kinds: FIELD_KINDS[name] }] : [];
  });
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
  if (element.disabled || element instanceof element.ownerDocument.defaultView!.HTMLInputElement && (element.readOnly || /^(hidden|password|file|submit|button|checkbox|radio)$/i.test(element.type))) return false;
  if (element instanceof element.ownerDocument.defaultView!.HTMLTextAreaElement && element.readOnly) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style?.display !== "none" && style?.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function setControlValue(element: WalletControl, requestedValue: string): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  let value = requestedValue;
  let prototype: object;
  if (element instanceof view.HTMLSelectElement) {
    const direct = Array.from(element.options).find((option) => option.value === requestedValue);
    const byLabel = Array.from(element.options).find((option) => option.textContent?.trim().toLocaleLowerCase() === requestedValue.trim().toLocaleLowerCase());
    const option = direct || byLabel;
    if (!option) return false;
    value = option.value;
    prototype = view.HTMLSelectElement.prototype;
  } else if (element instanceof view.HTMLTextAreaElement) {
    prototype = view.HTMLTextAreaElement.prototype;
  } else {
    prototype = view.HTMLInputElement.prototype;
  }
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new view.Event("change", { bubbles: true }));
  return true;
}
