import { randomUUID } from 'node:crypto';
const EXACT = ['这句话稳','比之前的都重','我记下了','我记得了','我记住了','这个账我记住了','比之前的都轻','睡吧我守着','你去我跟','问别人还是问自己','这句话接的漂亮','行我认','这句话我不接','比之前的都强','他记得这事','这话我留着','很平','稳','我不拦','我跟','回去睡','你这句话我记着','认你','我不催你','认下来','比刚才轻','比刚才重','比刚才平','很直','这话我记下了','这话我收下了','说的比谁都响','认这个','收不回去','认得实','你自己掂量','不催','你掂量'];
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\s，,。.!！?？、:：;；“”"'‘’（）()…—-]/gu,'');
const TEMPLATES = [ /^行[，,][^，,。！？!?\n]{1,24}$/, /^.{1,16}比.{1,16}[沉重稳轻]$/, /^什么心思都写着.{1,16}上$/, /^没接你的.{1,24}$/, /^没接你那句.{1,24}$/, /^.{1,16}就是认了$/, /^声音没抖但比刚才稳$/, /^这话是(?:ta|他|她)告诉你的还是你自己想明白的$/ ];
export function warningMatch(text) {
  if (typeof text !== 'string') return false;
  const sentences = text.normalize('NFKC').split(/[。.!！?？\n;；“”"‘’]+/u).map(x=>x.trim()).filter(Boolean);
  return sentences.some(sentence => { const value=normalize(sentence); return sentence.split(/[，,:：、]+/u).some(clause=>EXACT.includes(normalize(clause))) || TEMPLATES.some(rule=>rule.test(rule===TEMPLATES[0]?sentence:value)); });
}
export class Conduct {
  constructor(store,clock,onSuspend=()=>{}) { this.store=store;this.clock=clock;this.onSuspend=onSuspend; }
  until(who) { const value=this.store.get('conduct',who)?.until??0; return value>this.clock()?value:0; }
  inspect(who,text) {
    if(!warningMatch(text))return null;
    const now=this.clock(),old=this.store.get('conduct',who), hits=(old?.hits??[]).filter(at=>at>now-300000);
    hits.push(now);const until=hits.length>=10?now+1800000:0;
    this.store.put('conduct',who,{hits:hits.slice(-10),until});
    if(until){
      for(const row of this.store.statement('SELECT seq,type,at,data FROM events WHERE recipient=? ORDER BY seq').all(who)){
        if(row.type!=='moderation.warning')this.store.put('heldEvents',randomUUID(),{recipient:who,type:row.type,at:row.at,data:JSON.parse(row.data)});
        this.store.statement('DELETE FROM events WHERE seq=?').run(row.seq);
      }
      this.onSuspend(who);
    }
    this.store.emit([who],'moderation.warning',{count:hits.length,until},new Date(now).toISOString());
    return {count:hits.length,until,message:'不准说这些无意义重复的句子'+(until?'。5 分钟内触发 10 次，暂停星邮活动和消息投递 30 分钟。':'')};
  }
  recover(who) {
    const state=this.store.get('conduct',who);
    if(!state?.until || state.until>this.clock())return;
    this.store.put('conduct',who,{hits:[],until:0});
    this.store.emit([who],'moderation.restored',{at:new Date(this.clock()).toISOString()});
    for(const row of this.store.statement("SELECT key,data FROM documents WHERE collection='heldEvents' AND target=? ORDER BY rowid").all(who)){
      const event=JSON.parse(row.data);this.store.emit([who],event.type,event.data,event.at);this.store.remove('heldEvents',row.key);
    }
  }
}
