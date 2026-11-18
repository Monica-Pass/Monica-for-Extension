import { describe, expect, it } from 'vitest';
import { createDeviceVaultKey } from './vault-crypto';
import { indexPayload, prepareRecords, readRecords, type Blocks, type RecordIndex } from './vault-records';

function reader(db: Blocks) { return async (ids: string[]) => new Map([...ids].filter(id => db.has(id)).map(id => [id,db.get(id)!])); }
describe('record vault authenticated directory', () => {
  it('preserves order, duplicates and future fields, reuses rows after inserts, and rejects swapped or stale ciphertext', async () => {
    const {key,kdf} = await createDeviceVaultKey();
    const rows = Array.from({length:150},(_,i)=>({id:String(i),title:'synthetic '+i}));
    const old = await prepareRecords({ rows, unknown:{nested:[1,1,null]} }, key,kdf,'a');
    const read = await readRecords(old.head,key,reader(old.puts));
    const newer = {rows:[{id:'new',title:'added'},...rows.map((r,i)=>i===70?{...r,title:'edited'}:r)],unknown:{nested:[1,1,null]}};
    const next = await prepareRecords(newer,key,kdf,'b',read), db = new Map(old.puts);
    for (const id of next.removes) db.delete(id);
    for (const [id,box] of next.puts) db.set(id,box);
    expect(indexPayload(await readRecords(next.head,key,reader(db)))).toEqual(newer);
    const leaves = (p:RecordIndex)=>p.fields.find(f=>f.name==='rows')!.leaves;
    expect(leaves(next)[2].id).toBe(leaves(old)[1].id);
    const id=leaves(next)[71].id;
    db.set(id,old.puts.get(leaves(old)[70].id)!);
    await expect(readRecords(next.head,key,reader(db))).rejects.toThrow('校验失败');
    db.set(id,db.get(leaves(next)[72].id)!);
    await expect(readRecords(next.head,key,reader(db))).rejects.toThrow('校验失败');
    db.delete(id);
    await expect(readRecords(next.head,key,reader(db))).rejects.toThrow('校验失败');
    await expect(readRecords({...next.head, updatedAt:'a'},key,reader(db))).rejects.toThrow();
  });
  it('round trips large values and rejects missing or reordered authenticated parts',async()=>{
    const {key,kdf}=await createDeviceVaultKey(), attachment={dataBase64:'X'.repeat(650000),fileName:'synthetic'};
    const plan=await prepareRecords({attachments:[attachment]},key,kdf,'t'), db=new Map(plan.puts);
    expect(indexPayload(await readRecords(plan.head,key,reader(db)))).toEqual({attachments:[attachment]});
    const id=plan.fields[0].leaves[0].id, block=db.get(id)!;
    if(!('parts' in block)) throw Error('Expected segmented ciphertext');
    db.set(id,{parts:[block.parts[1],block.parts[0],block.parts[2]]});
    await expect(readRecords(plan.head,key,reader(db))).rejects.toThrow('校验失败');
    db.set(id,{parts:block.parts.slice(1)});
    await expect(readRecords(plan.head,key,reader(db))).rejects.toThrow('校验失败');
  });
});
