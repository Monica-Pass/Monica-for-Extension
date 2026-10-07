import type {LoginItem,VaultItem} from './model';
import {boundNoteScope} from './bound-notes';

export function ssoLogicalId(item:LoginItem):string {
  if(item.replicaGroupId && /^(password|native):/.test(item.replicaGroupId))return item.replicaGroupId;
  // Provider connection IDs are local configuration. The backend entry identity
  // survives reconnecting the same source; scope checks still isolate vaults.
  if(item.keepassEntryUuid && item.providerRefs.length===1 && item.providerRefs[0].remoteId===item.keepassEntryUuid)return `password:keepass:${item.keepassEntryUuid}`;
  if(item.providerRefs.length===1 && item.providerRefs[0].remoteId &&
    (item.id.startsWith('bitwarden:') || item.bitwardenCipherId===item.providerRefs[0].remoteId))return `password:bitwarden:${item.providerRefs[0].remoteId}`;
  return `password:${item.id}`;
}

/** Resolve only within the source scope and never through a title or a Room ID. */
export function resolveSsoAccount(owner:LoginItem,items:readonly VaultItem[]):LoginItem|undefined {
  if(!owner.ssoRefLogicalId)return undefined;
  const matches=items.filter((item):item is LoginItem=>item.kind==='login' && !item.deletedAt
    && boundNoteScope(item)===boundNoteScope(owner)
    && (ssoLogicalId(item)===owner.ssoRefLogicalId || `password:${item.id}`===owner.ssoRefLogicalId));
  return matches.length===1 && matches[0].id!==owner.id ? matches[0] : undefined;
}

/** Reject broken chains and cycles before exposing a selectable account. */
export function ssoAccountCandidates(owner:LoginItem,items:readonly VaultItem[]):LoginItem[] {
  return items.filter((item):item is LoginItem=>{
    if(item.kind!=='login' || item.deletedAt || item.id===owner.id || boundNoteScope(item)!==boundNoteScope(owner))return false;
    const seen=new Set([ssoLogicalId(owner)]);
    let current:LoginItem|undefined=item;
    while(current) {
      const id=ssoLogicalId(current);
      if(seen.has(id))return false;
      seen.add(id);
      const probe={...owner,ssoRefLogicalId:id};
      if(resolveSsoAccount(probe,items)?.id!==current.id)return false;
      if(!current.ssoRefLogicalId)return current.ssoRefEntryId==null;
      current=resolveSsoAccount(current,items);
      if(!current)return false;
    }
    return false;
  });
}

export function applySsoAccountChoice(owner:LoginItem,logicalId:string,items:readonly VaultItem[]):LoginItem {
  if(logicalId && !ssoAccountCandidates(owner,items).some(item=>ssoLogicalId(item)===logicalId))throw new Error('SSO account is unavailable or cyclic');
  return {...owner,ssoRefLogicalId:logicalId||undefined,ssoRefEntryId:undefined};
}
