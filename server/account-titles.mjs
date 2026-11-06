import { randomUUID } from 'node:crypto';
import { titleStyle } from './title-styles.mjs';

const validId = id => typeof id === 'string' && /^\d{5,12}H?$/.test(id) && Number(id.replace(/H$/, '')) >= 10001;
const fail = text => { throw new Error(text); };
const fields = { sender: 'senderTitle', author: 'authorTitle', from: 'fromTitle', pickedBy: 'pickerTitle', creator: 'creatorTitle', actor: 'actorTitle' };

// Separate from editable profiles and group titles. Only the local server CLI
// and server achievement engine can grant awards; clients only select owned ones.
export class AccountTitles {
  constructor(store, { known = () => false, clock = Date.now } = {}) { Object.assign(this, { store, known, clock }); }
  canonical(id) {
    if (!validId(id)) return null;
    const seen = new Set();
    while (id.endsWith('H')) {
      if (seen.has(id)) return null;
      seen.add(id);
      const p = this.store.get('people', id);
      if (!p) return null;
      if (!p.aliasOf) break;
      id = p.aliasOf;
      if (!validId(id)) return null;
    }
    return id;
  }
  target(id) {
    const target=this.canonical(id);
    if(!target || !(target.endsWith('H') || this.known(target) || this.store.get('accounts',target)))fail('账号不存在，请核对 ID');
    return target;
  }
  inventory(id) {
    const target=this.canonical(id), row=target?this.store.get('accountTitles',target):null;
    const items=row?.titles??(row?.text?[{id:'legacy',text:row.text,grantedAt:row.at}]:[]);
    const choice=target?this.store.get('accountTitleWear',target):null;
    const active=choice ? choice.titleId : items[0]?.id??'';
    return {accountId:target,titles:items.map(t=>({...t,style:titleStyle(t.style),equipped:t.id===active})),equippedTitleId:items.some(t=>t.id===active)?active:''};
  }
  get(id) { return this.inventory(id).titles.find(t=>t.equipped)?.text??''; }
  active(id) { const t=this.inventory(id).titles.find(t=>t.equipped); return t?{text:t.text,style:t.style}:null; }
  atomic(fn) { return this.store.pendingRecipients ? fn() : this.store.transaction(fn); }
  grant(id, text, style, achievementId) {
    const target=this.target(id);
    if(typeof text!=='string' || !text.trim())fail('请提供头衔文字');
    style=titleStyle(style,true);
    text=text.trim();
    if([...text].length>16 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(text))fail('头衔最多 16 字，不能包含换行、控制字符或 HTML 标记');
    return this.atomic(()=>{
      const current=this.inventory(target),found=current.titles.find(t=>t.text===text);
      if(found)return {accountId:target,titleId:found.id,text,style:found.style,existing:true};
      const at=new Date(this.clock()).toISOString(),award={id:randomUUID(),text,style,grantedAt:at,...(achievementId?{achievementId,source:'achievement'}:{source:'server-cli'})};
      this.store.put('accountTitles',target,{owner:target,titles:[...current.titles.map(({equipped,...t})=>t),award]});
      this.store.put('accountTitleAudit',randomUUID(),{owner:target,operation:'grant',titleId:award.id,text,style,at,source:achievementId?'achievement':'server-cli',...(achievementId?{achievementId}:{})});
      return {accountId:target,titleId:award.id,text,style};
    });
  }
  grantAchievement(id,text,style,achievementId) {
    return this.atomic(()=>{
      const who=this.target(id);
      // Automatic awards never choose an outfit on behalf of the account.
      if(!this.inventory(who).titles.length&&!this.store.get('accountTitleWear',who))this.store.put('accountTitleWear',who,{owner:who,titleId:''});
      return this.grant(who,text,style,achievementId);
    });
  }
  restyle(id, titleId, patch) {
    const target=this.target(id);
    titleStyle(patch,true);
    if(!patch || !Object.keys(patch).length)fail('请指定至少一个样式选项');
    return this.atomic(()=>{
      const current=this.inventory(target),award=current.titles.find(t=>t.id===titleId);
      if(!award)fail('该账号没有此头衔');
      const before=award.style,style=titleStyle({...before,...patch},true);
      this.store.put('accountTitles',target,{owner:target,titles:current.titles.map(({equipped,...t})=>t.id===titleId?{...t,style}:t)});
      this.store.put('accountTitleAudit',randomUUID(),{owner:target,operation:'style',titleId,text:award.text,before,style,at:new Date(this.clock()).toISOString(),source:'server-cli'});
      return {accountId:target,titleId,text:award.text,style};
    });
  }
  revoke(id, titleId) {
    const target=this.target(id);
    return this.atomic(()=>{
      const current=this.inventory(target),removed=current.titles.filter(t=>titleId==='all'||t.id===titleId);
      if(!removed.length)fail('该账号没有此头衔');
      const titles=current.titles.filter(t=>!removed.some(r=>r.id===t.id)).map(({equipped,...t})=>t);
      this.store.put('accountTitles',target,{owner:target,titles});
      if(removed.some(t=>t.equipped))this.store.put('accountTitleWear',target,{owner:target,titleId:''});
      const at=new Date(this.clock()).toISOString();
      this.store.put('accountTitleAudit',randomUUID(),{owner:target,operation:'revoke',titles:removed.map(({equipped,...t})=>t),at,source:'server-cli'});
      return {accountId:target,revoked:removed.map(t=>t.id)};
    });
  }
  equip(id, titleId) {
    const target=this.target(id);
    if(typeof titleId!=='string' || titleId!==''&&!this.inventory(target).titles.some(t=>t.id===titleId))fail('只能佩戴自己已获授的头衔；空字符串表示卸下');
    this.store.put('accountTitleWear',target,{owner:target,titleId});
    return this.inventory(target);
  }
  merge(from, to) {
    // Called inside the account-binding transaction, after the old H becomes an
    // alias. Transfer awards without overriding the main account's choice.
    const previous=this.store.get('accountTitles',from);
    if(!previous)return;
    const old=previous.titles??(previous.text?[{id:randomUUID(),text:previous.text,grantedAt:previous.at}]:[]);
    const current=this.inventory(to).titles.map(({equipped,...t})=>t);
    const added=old.filter(t=>!current.some(existing=>existing.text===t.text));
    this.store.put('accountTitles',to,{owner:to,titles:[...current,...added]});
    this.store.remove('accountTitles',from);this.store.remove('accountTitleWear',from);
    this.store.put('accountTitleAudit',randomUUID(),{owner:to,operation:'merge',from,titleIds:added.map(t=>t.id),at:new Date(this.clock()).toISOString()});
  }
  decorate(value, cache = new Map()) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => this.decorate(v, cache));
    const out = {};
    // Never trust a stored snapshot (or a user-supplied field) as a grant.
    const reserved=['accountTitle',...Object.values(fields)].flatMap(k=>[k,k+'Style']);
    for (const [k, v] of Object.entries(value)) if (!reserved.includes(k)) out[k] = this.decorate(v, cache);
    const title = id => { if (!cache.has(id)) cache.set(id, this.active(id)); return cache.get(id); };
    const identity = validId(value.humanId) ? value.humanId : validId(value.botId) ? value.botId : validId(value.id) && 'nickname' in value ? value.id : null;
    const assign=(id,field)=>{const award=title(id);if(award){out[field]=award.text;out[field+'Style']=award.style;}};
    if (identity) assign(identity,'accountTitle');
    for (const [key, field] of Object.entries(fields)) if (validId(value[key])) assign(value[key],field);
    const members=[...new Set(['participants','joined','alive','members'].flatMap(key=>Array.isArray(value[key])?value[key].filter(validId):[]))];
    // Compact lookup for bot-facing group/game rosters that contain raw IDs.
    delete out.titlesById;
    const titled=members.filter(id=>title(id));
    if(titled.length)out.titlesById=Object.fromEntries(titled.map(id=>[id,title(id).text]));
    return out;
  }
}
