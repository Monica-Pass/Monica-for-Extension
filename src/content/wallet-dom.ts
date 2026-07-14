import type { WalletFieldName, WalletFillKind, WalletFillPayload, WalletFillResult } from "../runtime/messages";

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
  ["cardSecurityCode", /^(cvv|cvc|cardsecuritycode|cardverificationcode)$/],
  ["cardExpiryMonth", /^(card|cc)?expir(y|ation)?month$/],
  ["cardExpiryYear", /^(card|cc)?expir(y|ation)?year$/],
  ["cardExpiry", /^(card|cc)?expir(y|ation)?(date)?$/],
  ["cardholderName", /^(cardholder|cardholdername|nameoncard)$/],
  ["cardNumber", /^(card|cc)(number|no)$/],
  ["documentNumber", /^(passport|passportnumber|documentnumber|identitynumber|idcardnumber|driverslicen[cs]enumber|socialsecuritynumber|ssn)$/],
  ["birthDate", /^(birthdate|dateofbirth|dob)$/],
  ["nationality", /^nationality$/],
  ["routingNumber", /^(routing|routingnumber|abarn)$/],
  ["swiftBic", /^(swift|swiftbic|bic|biccode)$/],
  ["iban", /^iban(number)?$/],
  ["paymentAccountId", /^(payment)?accountid$/],
  ["paymentAccountNumber", /^(bank|payment)accountnumber$/],
  ["paymentAccountHolder", /^(account)?holder(name)?$/],
  ["paymentProvider", /^(payment)?provider$/],
  ["paymentAccountName", /^paymentaccountname$/],
  ["paymentUsername", /^paymentusername$/],
  ["firstName", /^(firstname|givenname)$/], ["middleName", /^(middlename|additionalname)$/], ["lastName", /^(lastname|surname|familyname)$/],
  ["fullName", /^(fullname|recipientname)$/], ["company", /^(company|organization)$/],
  ["streetAddress", /^(streetaddress|addressline1|address1)$/], ["apartment", /^(apartment|addressline2|address2)$/],
  ["city", /^(city|town)$/], ["stateProvince", /^(state|province|stateprovince)$/], ["postalCode", /^(postalcode|postcode|zipcode|zip)$/],
  ["country", /^(country|countryname)$/], ["phone", /^(phone|phonenumber|telephone|tel)$/], ["email", /^(email|emailaddress)$/],
  ["currency", /^(currency|transactioncurrency)$/]
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
  return Array.from(rootDocument.querySelectorAll<WalletControl>("input,select,textarea")).flatMap((element) => {
    if (!visibleControl(element)) return [];
    const autocomplete = element.autocomplete.toLowerCase().split(/\s+/).reverse().find((token) => AUTOCOMPLETE_FIELDS[token]);
    const name = autocomplete ? AUTOCOMPLETE_FIELDS[autocomplete] : heuristicField(element);
    return name ? [{ element, name, kinds: FIELD_KINDS[name] }] : [];
  });
}

function heuristicField(element: WalletControl): WalletFieldName | undefined {
  const hints = [element.id, element.getAttribute("name"), element.getAttribute("aria-label"), element.getAttribute("placeholder"), ...Array.from(element.labels || []).map((label) => label.textContent)]
    .map((value) => normalizeHint(value || "")).filter(Boolean);
  return HEURISTICS.find(([, pattern]) => hints.some((hint) => pattern.test(hint)))?.[0];
}

function normalizeHint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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
