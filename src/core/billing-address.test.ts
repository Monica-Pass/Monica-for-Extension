import { describe, expect, it } from "vitest";
import { editBillingAddressField, readBillingAddress } from "./billing-address";

describe("Android BankCardData BillingAddress string", () => {
  it("projects the six known fields without rewriting the stored JSON", () => {
    const raw = ' {"city":" City ","postalCode":null,"future":9007199254740993} ';
    expect(readBillingAddress(raw)).toMatchObject({editable:true,fields:{city:" City ",postalCode:""}});
    expect(editBillingAddressField(raw,"city"," City ")).toBe(raw);
    expect(editBillingAddressField(raw,"postalCode","")).toBe(raw);
  });
  it("changes only one member, retaining null, unknown nested values and omitted fields", () => {
    const raw = '{"city":"Before","postalCode":null,"future":{"n":9007199254740993,"a":[false,""]}}';
    const edited = editBillingAddressField(raw,"city","After");
    expect(edited).toBe('{"city":"After","postalCode":null,"future":{"n":9007199254740993,"a":[false,""]}}');
    expect(edited).not.toContain('"country"');
    expect(editBillingAddressField("","streetAddress","  Street  ")).toBe('{"streetAddress":"  Street  "}');
  });
  it.each(['plain address','[1,2]','9007199254740993','null','{"city":{"future":true}}','{"city":false}'])('does not replace unsupported source %s',raw=>{
    expect(readBillingAddress(raw).editable).toBe(false);
    expect(()=>editBillingAddressField(raw,"city","new")).toThrow();
  });
});
