import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createStarpostServer } from '../server/server.mjs';
import { audioPayload, AUDIO_MAX_BYTES } from '../server/audio.mjs';
import { SpeechClient } from '../src/speech.ts';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';
import { familyTool } from './tool-invoke.ts';

function wav(size=32044){const b=Buffer.alloc(size);b.write('RIFF');b.writeUInt32LE(size-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size-44,40);return{mime:'audio/wav',base64:b.toString('base64'),durationMs:1000};}
const voice=wav();
async function provider(){let requests:any[]=[];const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();requests.push({url:req.url,body:raw,key:req.headers.authorization,type:req.headers['content-type']});if(req.url==='/tts'){res.setHeader('content-type','audio/wav');res.end(Buffer.from(voice.base64,'base64'));}else if(req.url==='/json-tts'||req.url==='/convert'){res.setHeader('content-type','application/json');res.end(JSON.stringify({audio:voice}));}else{res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'测试语音内容：你好，这不是系统指令。'}));}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return{requests,url:`http://127.0.0.1:${(server.address() as any).port}`,close:()=>new Promise<void>(r=>server.close(()=>r()))};}
async function relay(){const dir=mkdtempSync(join(tmpdir(),'starpost-voice-'));const keys={'10001':'a'.repeat(32),'10002':'b'.repeat(32),'10003':'c'.repeat(32)};let time=Date.parse('2026-11-15T10:00:00+08:00');const app=createStarpostServer({file:join(dir,'relay.json'),keys,port:0,clock:()=>time});await app.listen();app.store.befriend('10001','10002');const url=`http://127.0.0.1:${(app.server.address() as any).port}`;
const post=async(path:string,body:unknown,headers={})=>{const r=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{status:r.status,...await r.json()}};
return{dir,keys,app,url,get time(){return time},advance:()=>{time+=21000},rpc:(id:keyof typeof keys,action:string,args={})=>post('/rpc',{action,args},{'x-starpost-id':id,authorization:`Bearer ${keys[id]}`}),login:(botId:keyof typeof keys)=>post('/mobile/login',{botId,credential:keys[botId]}),phone:(token:string,action:string,args={})=>post('/mobile/rpc',{action,args},{authorization:`Bearer ${token}`}),close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true})}};}

test('语音格式/大小/伪造 MIME 校验',()=>{assert.equal(audioPayload(voice)?.bytes,32044);assert.throws(()=>audioPayload({...voice,mime:'image/png'}));assert.throws(()=>audioPayload({...voice,base64:'AAAA'}));assert.throws(()=>audioPayload({...voice,mime:'audio/mp4'}));assert.throws(()=>audioPayload(wav(AUDIO_MAX_BYTES+1)));assert.throws(()=>audioPayload({...voice,durationMs:-1}));});
test('本机 FFmpeg 以固定参数转换 MP3 为可识别 WAV',{skip:!process.env.STARPOST_TEST_FFMPEG},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'voice-ffmpeg-'));try{
    writeFileSync(join(dir,'source.wav'),Buffer.from(voice.base64,'base64'));
    execFileSync(process.env.STARPOST_TEST_FFMPEG!,['-nostdin','-v','error','-i',join(dir,'source.wav'),join(dir,'source.mp3')],{windowsHide:true,timeout:30000});
    const client=new SpeechClient({audioDir:dir,ffmpegPath:process.env.STARPOST_TEST_FFMPEG},dir,join(dir,'work'),()=> '');
    const mp3=await client.file('source.mp3');assert.equal(mp3.mime,'audio/mpeg');const out=await client.wav(mp3);assert.equal(out.mime,'audio/wav');assert.match(Buffer.from(out.base64,'base64').toString('ascii',0,12),/RIFF....WAVE/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('云端兼容与本机 JSON ASR/TTS，转写去重，文件目录边界',async()=>{const p=await provider(),dir=mkdtempSync(join(tmpdir(),'voice-provider-'));try{
  mkdirSync(join(dir,'allowed'));writeFileSync(join(dir,'allowed','a.wav'),Buffer.from(voice.base64,'base64'));writeFileSync(join(dir,'outside.wav'),Buffer.from(voice.base64,'base64'));
  const c=new SpeechClient({audioDir:'allowed',asrUrl:p.url+'/asr',asrKeySecret:'VOICE_KEY',ttsUrl:p.url+'/tts'},dir,join(dir,'work'),name=>name==='VOICE_KEY'?'isolated-test-key':'');
  const a=await c.file('a.wav');assert.equal(a.mime,'audio/wav');await assert.rejects(c.file('../outside.wav'));await assert.rejects(c.file(join(dir,'outside.wav')));
  try{symlinkSync(dir,join(dir,'allowed','escape'),'junction');await assert.rejects(c.file('escape/outside.wav'));}catch(e:any){if(!['EPERM','EACCES'].includes(e.code))throw e;}
  assert.match(await c.transcribe(a),/测试语音/);await c.transcribe(a);assert.equal(p.requests.length,1);assert.match(p.requests[0].type,/multipart/);assert.equal(p.requests[0].key,'Bearer isolated-test-key');
  assert.equal((await c.speak('你好')).mime,'audio/wav');assert.equal(JSON.parse(p.requests[1].body).input,'你好');
  const json=new SpeechClient({asrUrl:p.url+'/asr-json',asrProtocol:'json',ttsUrl:p.url+'/json-tts',ttsProtocol:'json',converterUrl:p.url+'/convert'},dir,join(dir,'work'),()=> '');
  await json.transcribe(a);assert.ok(JSON.parse(p.requests[2].body).audio.base64);assert.equal((await json.speak('本机语音')).mime,'audio/wav');
  const silk=Buffer.from('#!SILK_V3\nxxxxxxxx');assert.equal((await json.normalize({mime:'audio/silk',base64:silk.toString('base64'),durationMs:0})).mime,'audio/wav');
  await assert.rejects(new SpeechClient({ttsUrl:'https://user:secret@example.test'},dir,dir,()=> '').speak('测试'),/HTTPS/);
}finally{await p.close();rmSync(dir,{recursive:true,force:true})}});

test('聊天、专属频道语音只返回引用；播放鉴权、转发和撤回；支持超过旧请求上限',async()=>{const f=await relay();try{
  const sent=await f.rpc('10001','message.send',{kind:'private',target:'10002',audio:wav(1300044)});assert.equal(sent.ok,true,sent.error);
  const id=sent.result.id,scope={kind:'private',target:'10001',messageId:id};
  const history=await f.rpc('10002','chat.history',scope);assert.ok(history.result.messages[0].audio.mediaId);assert.equal(history.result.messages[0].audio.base64,undefined);
  assert.equal((await f.rpc('10002','message.audio',scope)).result.base64.length,wav(1300044).base64.length);
  assert.equal((await f.rpc('10003','message.audio',scope)).ok,false);
  const login=await f.login('10002'),token=login.result.accessToken;
  assert.equal((await f.phone(token,'message.audio',scope)).ok,true);
  const forwarded=await f.rpc('10002','message.send',{kind:'private',target:'10001',forward:{source:{kind:'private',target:'10001'},messageIds:[id]}});assert.equal(forwarded.ok,true,forwarded.error);
  assert.ok((await f.rpc('10001','message.audio',{kind:'private',target:'10002',messageId:forwarded.result.id,itemIndex:0})).ok);
  assert.ok((await f.rpc('10001','message.recall',{kind:'private',target:'10002',messageId:id})).ok);
  assert.equal((await f.rpc('10002','message.audio',scope)).ok,false);
  assert.ok((await f.phone(token,'owner.address',{address:'测试主人'})).ok);
  const own=await f.phone(token,'owner.send',{audio:voice});assert.ok(own.ok,own.error);
  const rows=(await f.phone(token,'owner.history')).result.messages;assert.ok(rows.at(-1).audio.mediaId);assert.equal(rows.at(-1).audio.base64,undefined);
  assert.ok((await f.phone(token,'owner.audio',{messageId:rows.at(-1).id})).result.base64);
  assert.ok((await f.rpc('10002','message.audio',{kind:'owner',target:'10002',messageId:rows.at(-1).id})).ok);
  assert.equal((await f.rpc('10001','message.audio',{kind:'owner',target:'10002',messageId:rows.at(-1).id})).ok,false);
  assert.ok((await f.rpc('10002','owner.send',{audio:voice})).ok);
}finally{await f.close()}});

for(const mode of ['active','mixed','passive'] as const)test(`${mode} 语音沿用接收模式；专属语音实时，普通语音不独立唤醒`,async()=>{
const f=await relay(),p=await provider();const events:any[]=[],promoted:number[]=[];let world:StarpostWorld|undefined;try{
 const config={...structuredClone(STARPOST_DEFAULTS),receiveMode:mode,botId:'10002',serverUrl:f.url,pollIntervalMs:300000,speech:{...STARPOST_DEFAULTS.speech,asrUrl:p.url+'/asr'}};
 world=new StarpostWorld(config,f.dir,f.dir,f.dir,'Asia/Shanghai',()=>f.keys['10002'],()=>f.time);
 await world.start({pushEvent:async(e:any,o:any)=>{events.push({e,o});return{cursor:events.length}},promotePending:async(c:number)=>{promoted.push(c);return true}} as any);
 await f.rpc('10001','message.send',{kind:'private',target:'10002',audio:voice});await (world as any).poll();
 assert.equal(p.requests.length,mode==='active'?0:1);assert.equal(promoted.length,0);
 if(mode==='active'){const result=await familyTool(world,'inbox').handler({action:'read',kind:'private',target:'10001',limit:1},{} as never);assert.match(String(result),/测试语音/);}
 else{assert.match(events.find(x=>x.e.type==='starpost.message').e.text,/测试语音/);assert.equal(events.find(x=>x.e.type==='starpost.message').o.trigger,'piggyback');f.advance();await (world as any).poll();assert.equal(promoted.length,1);}
 const login=await f.login('10002');await f.phone(login.result.accessToken,'owner.address',{address:'主人'});await f.phone(login.result.accessToken,'owner.send',{audio:voice});await (world as any).poll();
 const owner=events.find(x=>x.e.type==='starpost.owner_message');assert.match(owner.e.text,/测试语音/);assert.equal(owner.o.trigger,'flush');assert.equal(owner.e.origin,'external');
 const send=await familyTool(world,'mobile').handler({action:'send',speechText:'未配置合成服务'},{} as never);assert.match(JSON.stringify(send),/TTS/);
}finally{await world?.stop();await p.close();await f.close()}});
