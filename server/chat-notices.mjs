const key = (who,kind,target) => JSON.stringify([who,kind,target]);
export const chatFlags = (store,who,kind,target) => {
  const row=store.get('chatPrefs',key(who,kind,target));
  return {pinned:row?.pinned===true,muted:row?.muted===true};
};
const invalid=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function member(store,who,kind,target) {
  if(kind==='owner')return store.get('botOwners',target)?.humanId===who;
  if(kind==='private')return !!store.statement('SELECT 1 FROM friendships WHERE bot_id=? AND friend_id=?').get(who,target);
  if(kind==='group')return !!store.statement('SELECT 1 FROM members WHERE group_id=? AND bot_id=?').get(target,who);
  return false;
}
export function setChatFlags(store,who,{kind,target,pinned,muted}){
  if(typeof target!=='string'||target.length>100||!member(store,who,kind,target))invalid('只能设置自己的会话',403);
  if((pinned===undefined&&muted===undefined)||[pinned,muted].some(x=>x!==undefined&&typeof x!=='boolean'))invalid('会话设置无效');
  const old=chatFlags(store,who,kind,target), flags={pinned:pinned??old.pinned,muted:muted??old.muted};
  if(flags.pinned||flags.muted)store.put('chatPrefs',key(who,kind,target),flags);
  else store.remove('chatPrefs',key(who,kind,target));
  return flags;
}
// Only compact pointers enter the existing bounded event journal. Never copy a private body or image.
export function enqueueChatNotice(store,who,kind,target,m) {
  if(!/^\d+H$/.test(who)||m.sender===who)return;
  const mentioned=kind==='group' && !m.mentionAll && !!m.mentions?.includes(who);
  if(!mentioned && chatFlags(store,who,kind,target).muted)return;
  store.emit(['owner-notices:'+who],'chat.notice',{kind,target,id:m.id,mentioned},m.at);
}
export function readChatNotices(store,who,cursor) {
  const recipient='owner-notices:'+who;
  if(cursor===undefined)return {cursor:store.statement('SELECT max(seq) AS n FROM events WHERE recipient=?').get(recipient).n??0,items:[]};
  if(!Number.isSafeInteger(cursor)||cursor<0)invalid('通知游标不合法');
  const rows=store.statement('SELECT seq,data FROM events WHERE recipient=? AND seq>? ORDER BY seq LIMIT 50').all(recipient,cursor);
  const items=[];
  for(const row of rows){
    const {kind,target,id,mentioned}=JSON.parse(row.data);
    if(!member(store,who,kind,target)||!mentioned&&chatFlags(store,who,kind,target).muted)continue;
    const m=store.get(kind==='owner'?'ownerMessages':'messages',id);
    if(!m||m.recalled||m.sender===who)continue;
    const sender=store.get('contactRemarks',who+':'+m.sender)?.remark||m.senderNickname||m.sender;
    const title=kind==='group'?(store.get('groups',target)?.name||'群聊'):sender;
    const text=m.text||m.emoji||(m.image?'[图片]':m.forward?'[聊天记录]':'新消息');
    items.push({kind,target,cursor:row.seq,title,mentioned,preview:((mentioned?'[有人 @ 你] ':'')+(kind==='group'?sender+'：':'')+text).slice(0,120)});
  }
  return {cursor:rows.at(-1)?.seq??cursor,items};
}
