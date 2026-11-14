import { AUDIO_MAX_BYTES } from './audio.mjs';
import { statSync, readFileSync } from 'node:fs';

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : fail('消息或会话 ID 不合法');

// Only original records read under the actor's permission may become quotes/forwards.
export class MessageActions {
  constructor(store, options) { Object.assign(this, { store }, options); }
  context(actor, kind, target) {
    key(target);
    if (kind === 'owner') {
      if(!/^\d{5,12}$/.test(target))fail('专属频道必须指定 bot ID');
      if (actor !== target && this.owner(target) !== actor) fail('只能操作自己的专属频道', 403);
      if (this.humanActive(target)) fail('人类参赛期间，人机私聊不可用', 423);
      return { collection: 'ownerMessages', kind, target, direction: actor === target ? 'bot' : 'human' };
    }
    if (!['private', 'group'].includes(kind)) fail('消息类型不合法');
    this.authorize(actor, kind, target);
    return { collection: 'messages', kind, target };
  }
  get(actor, args) {
    const c = this.context(actor, args.kind, args.target), m = this.store.get(c.collection, key(args.messageId));
    if (!m || (c.kind === 'owner' ? m.botId !== c.target : m.kind !== c.kind || (c.kind === 'group' ? m.target !== c.target : [m.sender,m.target].sort().join(':') !== [actor,c.target].sort().join(':')))) fail('消息不存在或无权查看', 404);
    return { c, m };
  }
  identity(m) {
    const sender = m.sender ?? (m.direction === 'bot' ? m.botId : this.owner(m.botId));
    return { sender: sender ?? '', senderNickname: m.senderNickname ?? this.profile(sender)?.nickname ?? m.address ?? sender ?? '' };
  }
  view(m) {
    const value = { ...m };
    if (m.recalled) return { ...value, text: '该消息已撤回', emoji: '', image: null, audio:null, quote: null, forward: null, mentions: [] };
    if (m.quote) {
      const original = this.store.get(m.quote.kind === 'owner' ? 'ownerMessages' : 'messages', m.quote.id);
      if (!original || original.recalled) value.quote = { ...m.quote, text: original ? '该消息已撤回' : '原消息已不可用', hasImage: false, hasAudio:false, recalled: true };
    }
    if (m.forward) { const { items, ...summary } = m.forward; value.forward = summary; }
    return value;
  }
  prepare(actor, kind, target, args) {
    this.context(actor, kind, target);
    let quote = null, forward = null;
    if (args.replyTo) {
      const { m } = this.get(actor, { kind, target, messageId: args.replyTo });
      if (m.recalled) fail('不能引用已撤回的消息');
      quote = { id: m.id, kind, ...this.identity(m), at: m.at, text: (m.text || (m.forward ? `[聊天记录 · ${m.forward.count} 条]` : '')).slice(0,300), hasImage: Boolean(m.image), hasAudio: Boolean(m.audio) };
    }
    if (args.forward) {
      const request = args.forward, ids = request.messageIds;
      if (!request.source || !Array.isArray(ids) || ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length) fail('请选择同一会话中的 1–20 条消息');
      const selected = ids.map(messageId => { const {c,m}=this.get(actor,{...request.source,messageId});return {m,order:this.store.statement('SELECT rowid FROM documents WHERE collection=? AND key=?').get(c.collection,m.id).rowid}; }).sort((a,b)=>a.order-b.order).map(row=>row.m);
      if (selected.some(m=>m.recalled)) fail('选择中包含已撤回的消息，请重新选择');
      const items = selected.flatMap(m=>m.forward?.items ?? [{ sourceMessageId: m.id, ...this.identity(m), at:m.at, text:m.text??'', emoji:m.emoji??'', quote:this.view(m).quote??null, image:m.image??null, audio:m.audio??null }]);
      if (items.length > 20) fail('展开后的合并记录不能超过 20 条');
      if (items.reduce((n,m)=>n+m.text.length+(m.emoji?.length??0),0) > 20000) fail('合并记录文字不能超过 20000 字');
      const bytes = items.reduce((n,m)=>n+(m.image ? statSync(this.store.mediaPath(m.image)).size : 0),0);
      if (bytes > 4*1024*1024) fail('合并记录中的图片合计不能超过 4 MiB，请减少选择');
      forward = { count:items.length, preview:items.slice(0,3).map(m=>`${m.senderNickname}：${(m.text||m.emoji||(m.image?'[图片]':m.audio?'[语音]':'')).slice(0,80)}`), items };
    }
    return { quote, forward };
  }
  read(actor, args) {
    const { m } = this.get(actor,args);
    return { message:this.view(m), ...(m.forward&&!m.recalled?{items:m.forward.items}:{}) };
  }
  image(actor, args) {
    const { m } = this.get(actor,args);
    if (m.recalled) fail('该消息已撤回',404);
    let image=m.image;
    if (args.itemIndex !== undefined) {
      if (!Number.isInteger(args.itemIndex)||args.itemIndex<0||args.itemIndex>= (m.forward?.items.length??0)) fail('记录序号不合法');
      image=m.forward.items[args.itemIndex].image;
    }
    if (!image) fail('该消息没有图片',404);
    return {mime:image.mime,base64:readFileSync(this.store.mediaPath(image)).toString('base64')};
  }
  audio(actor,args) {
    const {m}=this.get(actor,args);
    if(m.recalled)fail('该消息已撤回',404);
    let audio=m.audio;
    if(args.itemIndex!==undefined){if(!Number.isInteger(args.itemIndex)||args.itemIndex<0||args.itemIndex>=(m.forward?.items.length??0))fail('记录序号不合法');audio=m.forward.items[args.itemIndex].audio;}
    if(!audio)fail('该消息没有语音',404);
    const file=this.store.mediaPath(audio);if(statSync(file).size>AUDIO_MAX_BYTES)fail('语音超过大小限制',413);
    return {mime:audio.mime,durationMs:audio.durationMs??0,base64:readFileSync(file).toString('base64')};
  }
  recall(actor, args) {
    const { c,m }=this.get(actor,args);
    if (c.kind==='owner'?m.direction!==c.direction:m.sender!==actor) fail('只能撤回自己发送的消息',403);
    if(m.recalled)return {id:m.id,recalled:true};
    const age=this.clock()-Date.parse(m.at);
    if(!Number.isFinite(age)||age<0||age>120000)fail('只能撤回两分钟内发送的消息');
    const saved=this.store.put(c.collection,m.id,{...m,recalled:true,recalledAt:new Date(this.clock()).toISOString(),text:'该消息已撤回',emoji:'',image:null,audio:null,quote:null,forward:null,mentions:[]});
    // Remove not-yet-delivered bytes too, including deferred/game-held queues.
    const patch=JSON.stringify({recalled:true,text:'该消息已撤回',emoji:'',image:null,audio:null,quote:null,forward:null,mentions:[]});
    this.store.statement("UPDATE events SET data=json_patch(data,?) WHERE type IN ('message','owner.message') AND json_extract(data,'$.id')=?").run(patch,m.id);
    this.store.statement("UPDATE documents SET data=json_set(data,'$.data',json_patch(json_extract(data,'$.data'),?)) WHERE collection IN ('deferredChat','heldEvents') AND json_extract(data,'$.data.id')=?").run(patch,m.id);
    const recipients=c.kind==='owner'?[c.target]:c.kind==='group'?this.members(c.target):[actor,c.target];
    this.emit(recipients,'message.recalled',{id:m.id,kind:c.kind,target:c.target,sender:actor,at:saved.recalledAt});
    return {id:m.id,recalled:true};
  }
}
