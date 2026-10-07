import { describe, expect, it } from "vitest";
import { CONTENT_ORDER, moveContentToken, orderedContentTokens } from "./password-content";
import type { SecureCustomField } from "./model";

describe("content reorder preservation", () => {
  const fields: SecureCustomField[] = [
    {name:"custom",value:"9007199254740993",protected:true},
    {name:CONTENT_ORDER,value:"AUTHENTICATOR,FUTURE_TOKEN,NOTES,PAYMENT",protected:true},
    {name:"monica.content.block.11111111-1111-4111-8111-111111111111.0000",value:"exact encrypted-looking payload",protected:true}
  ];
  it("moves before or after a target without dropping unknown tokens or rewriting content", () => {
    const original = JSON.stringify(fields);
    const moved = moveContentToken(fields, "NOTES", "AUTHENTICATOR");
    expect(orderedContentTokens(moved).slice(0,3)).toEqual(["NOTES","AUTHENTICATOR","FUTURE_TOKEN"]);
    expect(moved.filter(field=>field.name!==CONTENT_ORDER)).toEqual(fields.filter(field=>field.name!==CONTENT_ORDER));
    const restored = moveContentToken(moved,"NOTES","FUTURE_TOKEN",true);
    expect(orderedContentTokens(restored)).toEqual(orderedContentTokens(fields));
    expect(JSON.stringify(fields)).toBe(original);
  });
  it("ignores missing or unchanged drag targets instead of corrupting the order", () => {
    expect(moveContentToken(fields,"gone","NOTES")).toBe(fields);
    expect(moveContentToken(fields,"NOTES","gone")).toBe(fields);
    expect(moveContentToken(fields,"NOTES","NOTES")).toBe(fields);
    expect(moveContentToken(fields,"AUTHENTICATOR","FUTURE_TOKEN")).toBe(fields);
  });
  it("refuses ambiguous duplicate order fields without changing the source", () => {
    const duplicate = [...fields,{name:CONTENT_ORDER,value:"NOTES",protected:false}];
    const before = JSON.stringify(duplicate);
    expect(()=>moveContentToken(duplicate,"NOTES","AUTHENTICATOR")).toThrow("重复");
    expect(JSON.stringify(duplicate)).toBe(before);
  });
});
