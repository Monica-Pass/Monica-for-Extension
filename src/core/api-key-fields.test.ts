import { expect, it } from 'vitest';
import type { SecureCustomField } from './model';
import { putApiKeyFields } from './credential-fields';

const marker: SecureCustomField = { name:'monica_api_key_type', value:'API_KEY', protected:false };

it.each([
  '/v1/chat/completions', 'internal service: staging', 'localhost:8080/api',
  'grpc://synthetic.invalid:443', 'https://user:synthetic@example.invalid/api',
  'javascript:synthetic()', '  服务地址\t第二行\nthird  ',
  'https://example.invalid/' + 'path'.repeat(600)
])('stores Android API address text without treating it as a navigation request: %s', endpoint => {
  const fields=putApiKeyFields([],endpoint);
  expect(fields.find(field=>field.name==='monica_api_key_url')?.value).toBe(endpoint);
  expect(fields.find(field=>field.name==='monica_api_key_type')?.value).toBe('API_KEY');
  expect(putApiKeyFields(fields,endpoint)).toBe(fields);
});

it('changes only the endpoint value, retaining field position, protection and metadata', () => {
  const endpoint={name:'monica_api_key_url',value:'/old',protected:true,fieldType:'HIDDEN' as const,id:91,sortOrder:12,future:{enabled:true}};
  const fields=[{name:'before',value:'kept',protected:true},endpoint,marker,{name:'after',value:'kept',protected:false}];
  const original=structuredClone(fields);
  expect(putApiKeyFields(fields,'/new')).toEqual([fields[0],{...endpoint,value:'/new'},marker,fields[3]]);
  expect(fields).toEqual(original);
  expect(putApiKeyFields(fields,'')).toEqual([fields[0],{...endpoint,value:''},marker,fields[3]]);
});

it('does not materialize an absent optional endpoint on unrelated saves', () => {
  const fields=[marker,{name:'future',value:'retained',protected:true}];
  expect(putApiKeyFields(fields,'')).toBe(fields);
  expect(putApiKeyFields([],'')).toEqual([marker]);
});

it('rejects ambiguous duplicate carriers before changing source fields', () => {
  for(const fields of [[marker,marker],[marker,...[1,2].map(value=>({name:'monica_api_key_url',value:String(value),protected:false}))]]) {
    const original=structuredClone(fields);
    expect(()=>putApiKeyFields(fields,'/new')).toThrow();
    expect(fields).toEqual(original);
  }
});
