import { createHash, randomUUID } from 'node:crypto';
const fail=(message,status=403)=>{const e=new Error(message);e.status=status;throw e;};
export class TeenGuard {
  constructor(store,{requirements,execute,leave,removeFriend,contacts=()=>({}),suspension=()=>0,clock}) {Object.assign(this,{store,requirements,execute,leave,removeFriend,contacts,suspension,clock});this.executing=null;}
  enabled(who){return this.store.get('teenSettings',who)?.enabled===true;}
  fingerprint(actor,action,args){return createHash('sha256').update(JSON.stringify([actor,action,args])).digest('hex');}
  gate(actor,action,args){
    const signature=this.fingerprint(actor,action,args);
    if(this.executing===signature)return null;
    const requirements=this.requirements(actor,action,args).filter(item=>this.enabled(item.owner)&&!this.store.get('teenGrants',`${item.owner}:${item.resource}`));
    if(!requirements.length)return null;
    let intent=this.store.list('teenIntents','target=? AND kind=?',[signature,'pending'],{limit:1})[0];
    if(!intent){
      if(this.store.count('teenIntents',"owner=? AND kind='pending'",[actor])>=20)fail('待审批操作已达 20 个，请等待用户处理',429);
      intent={id:randomUUID(),actor,action,args,signature,requirements,approved:[],status:'pending',at:new Date(this.clock()).toISOString()};this.store.put('teenIntents',intent.id,intent);
      for(const req of requirements)this.store.put('teenAccess',`${req.owner}:${intent.id}`,{owner:req.owner,intentId:intent.id});
    }
    return {pendingApproval:true,requestId:intent.id,message:'青少年模式：等待人类用户批准联系人或加群。请勿反复重试。'};
  }
  status(who){
    const pending=this.store.list('teenAccess','owner=?',[who],{limit:-1}).map(access=>this.store.get('teenIntents',access.intentId)).filter(item=>item?.status==='pending');
    return {enabled:this.enabled(who),suspendedUntil:this.suspension(who),...this.contacts(who),pending:pending.map(item=>({id:item.id,actor:item.actor,action:item.action,at:item.at,approved:item.approved.includes(who),targets:item.requirements.filter(req=>req.owner===who).map(req=>({resource:req.resource,label:req.label}))}))};
  }
  control(who,operation,args={}){
    if(operation==='status')return this.status(who);
    if(operation==='set'){
      if(typeof args.enabled!=='boolean')fail('enabled 须为布尔值',400);
      this.store.put('teenSettings',who,{enabled:args.enabled});this.store.emit([who],'teen.mode',{enabled:args.enabled});return this.status(who);
    }
    if(!this.enabled(who))fail('先开启青少年模式才能操作联系人管理');
    if(operation==='leave'){this.leave(who,args.groupId);this.store.remove('teenGrants',`${who}:group:${args.groupId}`);return {left:true};}
    if(operation==='removeFriend'){this.removeFriend(who,args.botId);return {removed:true};}
    if(operation!=='decide'||typeof args.approve!=='boolean')fail('未知操作',400);
    const intent=this.store.get('teenIntents',args.requestId);
    if(!intent||!intent.requirements.some(req=>req.owner===who))fail('审批不存在或不属于本账号');
    if(intent.status!=='pending')return {status:intent.status};
    if(!args.approve){intent.status='denied';this.store.put('teenIntents',intent.id,intent);this.store.emit([intent.actor],'teen.decision',{requestId:intent.id,approved:false});return {status:'denied'};}
    intent.approved=[...new Set([...intent.approved,who])];
    const fresh=this.requirements(intent.actor,intent.action,this.store.hydrate(intent.args)).filter(req=>this.enabled(req.owner)&&!this.store.get('teenGrants',`${req.owner}:${req.resource}`));
    for(const req of fresh)if(!intent.requirements.some(old=>old.owner===req.owner&&old.resource===req.resource)){intent.requirements.push(req);this.store.put('teenAccess',`${req.owner}:${intent.id}`,{owner:req.owner,intentId:intent.id});}
    this.store.put('teenIntents',intent.id,intent);
    if(intent.requirements.some(req=>this.enabled(req.owner)&&!intent.approved.includes(req.owner)))return {status:'pending',waitingForOthers:true};
    this.executing=this.fingerprint(intent.actor,intent.action,this.store.hydrate(intent.args));
    try{
      // Hydrated images keep the original validated API shape when a queued action resumes.
      const result=this.execute(intent.actor,intent.action,this.store.hydrate(intent.args));
      for(const req of intent.requirements)if(!req.resource.startsWith('create:'))this.store.put('teenGrants',`${req.owner}:${req.resource}`,{approvedAt:new Date(this.clock()).toISOString()});
      intent.status='completed';this.store.put('teenIntents',intent.id,intent);this.store.emit([intent.actor],'teen.decision',{requestId:intent.id,approved:true});
      return {status:'completed',result};
    }finally{this.executing=null;}
  }
}
