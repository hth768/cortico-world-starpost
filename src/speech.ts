import { readFile, stat, realpath, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { audioPayload, AUDIO_MAX_BYTES, AUDIO_EXTENSIONS } from '../server/audio.mjs';

export interface SpeechConfig {
  audioDir: string;
  asrUrl: string; asrProtocol: 'openai' | 'json'; asrModel: string; asrKeySecret: string;
  ttsUrl: string; ttsProtocol: 'openai' | 'json'; ttsModel: string; ttsVoice: string; ttsKeySecret: string;
  ffmpegPath: string; silkPath: string; converterUrl: string; converterKeySecret: string;
}
export const SPEECH_DEFAULTS: SpeechConfig = {
  audioDir: '', asrUrl: '', asrProtocol: 'openai', asrModel: 'whisper-1', asrKeySecret: '',
  ttsUrl: '', ttsProtocol: 'openai', ttsModel: 'tts-1', ttsVoice: 'alloy', ttsKeySecret: '',
  ffmpegPath: '', silkPath: '', converterUrl: '', converterKeySecret: '',
};
export interface Voice { mime: string; base64: string; durationMs: number; bytes?: number }
const formats: Record<string,string> = {'audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/webm':'matroska','audio/mp4':'mov'};
export function sniffVoice(bytes: Buffer): string {
  if(bytes.subarray(0,12).includes(Buffer.from('#!SILK_V3')))return 'audio/silk';
  for(const mime of Object.keys(AUDIO_EXTENSIONS)) {try{audioPayload({mime,base64:bytes.toString('base64')});return mime;}catch{}}
  throw new Error('不支持的语音格式；请选择 MP3、WAV、OGG、WebM、M4A 或配置 SILK 转换');
}
export class SpeechClient {
  readonly config: SpeechConfig;
  private cache = new Map<string,string>();
  private controller=new AbortController();
  constructor(config: Partial<SpeechConfig> | undefined, private baseDir: string, private dataDir: string, private secret: (name:string)=>string) {
    this.config={...SPEECH_DEFAULTS,...config};
  }
  resume(){if(this.controller.signal.aborted)this.controller=new AbortController();}
  abort(){this.controller.abort();}
  private async request(urlText:string, keyName:string, body:BodyInit, type?:string):Promise<{bytes:Buffer;type:string}> {
    const url=new URL(urlText);
    if(url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('语音服务须使用 HTTPS 或本机 HTTP 地址');
    if(keyName&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName))throw new Error('语音密钥配置应填写环境变量名');
    const key=keyName?this.secret(keyName):'';
    if(keyName&&!key)throw new Error('语音服务密钥未配置');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    try {
      const response=await fetch(url,{method:'POST',body,redirect:'error',signal:AbortSignal.any([controller.signal,this.controller.signal]),headers:{...(type?{'content-type':type}:{}),...(key?{authorization:`Bearer ${key}`}:{})}});
      if(!response.ok)throw new Error(`语音服务返回 HTTP ${response.status}`);
      const chunks:Buffer[]=[];let length=0;
      if(!response.body)throw new Error('语音服务返回空响应');
      for await(const part of response.body as any){length+=part.length;if(length>7*1024*1024){controller.abort();throw new Error('语音服务响应过大');}chunks.push(Buffer.from(part));}
      return {bytes:Buffer.concat(chunks),type:response.headers.get('content-type')??''};
    } catch(error) {if(error instanceof Error&&error.message.startsWith('语音服务'))throw error;throw new Error('语音服务连接失败或超时，请检查人类配置');}
    finally{clearTimeout(timer);}
  }
  private async run(file:string,args:string[]):Promise<void> {
    if(!isAbsolute(file)||!(await stat(file)).isFile())throw new Error('转换程序必须是人类配置的本机可执行文件绝对路径');
    await new Promise<void>((ok,fail)=>execFile(file,args,{shell:false,timeout:30000,maxBuffer:65536,windowsHide:true,signal:this.controller.signal},error=>error?fail(new Error('语音转换失败或超时，请检查转换程序配置')):ok()));
  }
  async normalize(value:Voice):Promise<Voice> {
    if(!value||typeof value.base64!=='string'||value.base64.length>Math.ceil(AUDIO_MAX_BYTES/3)*4)throw new Error('语音数据为空或超过 5 MiB');
    const bytes=Buffer.from(value.base64,'base64');
    if(bytes.length>AUDIO_MAX_BYTES)throw new Error('语音不能超过 5 MiB');
    const mime=sniffVoice(bytes);
    if(mime!=='audio/silk')return audioPayload({...value,mime})!;
    const c=this.config;
    if(c.converterUrl){const response=await this.request(c.converterUrl,c.converterKeySecret,JSON.stringify({audio:{...value,mime},targetMime:'audio/wav'}),'application/json');const audio=audioPayload(JSON.parse(response.bytes.toString()).audio);if(!audio)throw new Error('转换接口未返回音频');return audio;}
    if(!c.silkPath)throw new Error('收到 SILK 文件，请先配置 SILK 解码程序或 HTTP 转换接口');
    await mkdir(this.dataDir,{recursive:true});const temp=await mkdtemp(join(this.dataDir,'voice-'));
    try{const input=join(temp,'input.silk'),output=join(temp,'output.wav');await writeFile(input,bytes);await this.run(c.silkPath,['decode',input,output]);return await this.output(output,'audio/wav',value.durationMs);}
    finally{await rm(temp,{recursive:true,force:true});}
  }
  private async output(file:string,mime:string,durationMs=0):Promise<Voice>{if((await stat(file)).size>AUDIO_MAX_BYTES)throw new Error('转换后的语音超过 5 MiB');return audioPayload({mime,base64:(await readFile(file)).toString('base64'),durationMs})!;}
  async file(name:string):Promise<Voice> {
    if(!this.config.audioDir)throw new Error('请先由人类配置允许发送的语音文件夹');
    const root=await realpath(resolve(this.baseDir,this.config.audioDir)),file=await realpath(resolve(root,name)),rel=relative(root,file);
    if(!rel||rel.startsWith('..')||isAbsolute(rel)||!(await stat(file)).isFile())throw new Error('音频必须位于人类指定的语音目录内');
    if((await stat(file)).size>AUDIO_MAX_BYTES)throw new Error('语音不能超过 5 MiB');
    const bytes=await readFile(file);return this.normalize({mime:sniffVoice(bytes),base64:bytes.toString('base64'),durationMs:0});
  }
  async wav(audio:Voice):Promise<Voice>{
    const c=this.config;if(audio.mime==='audio/wav')return audio;
    if(c.converterUrl){const r=await this.request(c.converterUrl,c.converterKeySecret,JSON.stringify({audio,targetMime:'audio/wav'}),'application/json');const result=audioPayload(JSON.parse(r.bytes.toString()).audio);if(!result)throw new Error('转换接口未返回音频');return result;}
    if(!c.ffmpegPath)return audio;
    await mkdir(this.dataDir,{recursive:true});const temp=await mkdtemp(join(this.dataDir,'voice-'));
    try{const input=join(temp,'input'),output=join(temp,'output.wav');await writeFile(input,Buffer.from(audio.base64,'base64'));
      await this.run(c.ffmpegPath,['-nostdin','-v','error','-protocol_whitelist','file,pipe','-f',formats[audio.mime],'-i',input,'-map','0:a:0','-vn','-ac','1','-ar','16000','-fs',String(AUDIO_MAX_BYTES+1),'-y',output]);return await this.output(output,'audio/wav',audio.durationMs);
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  async transcribe(audio:Voice):Promise<string>{
    if(!this.config.asrUrl)throw new Error('ASR 未配置；语音已保留，可配置后使用 message/transcribe 重试');
    const safe=await this.normalize(audio),key=createHash('sha256').update(safe.base64).digest('hex');
    const cached=this.cache.get(key);if(cached!==undefined)return cached;
    const voice=await this.wav(safe),c=this.config;let body:BodyInit,type:string|undefined;
    if(c.asrProtocol==='json'){body=JSON.stringify({audio:voice,model:c.asrModel});type='application/json';}
    else{const form=new FormData();form.set('model',c.asrModel);form.set('file',new Blob([Buffer.from(voice.base64,'base64')],{type:voice.mime}),`voice.${AUDIO_EXTENSIONS[voice.mime]}`);body=form;}
    const r=await this.request(c.asrUrl,c.asrKeySecret,body,type),value=JSON.parse(r.bytes.toString());
    if(typeof value.text!=='string'||value.text.length>12000)throw new Error('ASR 返回的文字格式不合法');
    this.cache.set(key,value.text);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);return value.text;
  }
  async speak(text:string):Promise<Voice>{
    if(!text.trim()||text.length>2000)throw new Error('语音合成文字须为 1–2000 字');
    const c=this.config;if(!c.ttsUrl)throw new Error('请先由人类配置 TTS 服务');
    const payload=c.ttsProtocol==='json'?{text,model:c.ttsModel,voice:c.ttsVoice}:{input:text,model:c.ttsModel,voice:c.ttsVoice,response_format:'mp3'};
    const r=await this.request(c.ttsUrl,c.ttsKeySecret,JSON.stringify(payload),'application/json');
    return this.normalize(r.type.includes('json')?JSON.parse(r.bytes.toString()).audio:{mime:sniffVoice(r.bytes),base64:r.bytes.toString('base64'),durationMs:0});
  }
  async outgoing(args:Record<string,unknown>):Promise<Voice|null>{
    if(args.audioFile&&args.speechText)throw new Error('audioFile 和 speechText 只能选一个');
    if((args.audioFile||args.speechText)&&(args.imageFile||args.sticker))throw new Error('语音和图片请分开发送');
    if(args.audioFile)return this.file(String(args.audioFile));if(args.speechText)return this.speak(String(args.speechText));return null;
  }
}
