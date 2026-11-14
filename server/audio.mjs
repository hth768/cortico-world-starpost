export const AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIO_EXTENSIONS = Object.freeze({ 'audio/mpeg':'mp3', 'audio/wav':'wav', 'audio/ogg':'ogg', 'audio/webm':'webm', 'audio/mp4':'m4a' });
export function audioPayload(value) {
  if (value == null) return null;
  const fail = message => { throw Object.assign(new Error(message), {status:400}); };
  if (!value || typeof value !== 'object' || !AUDIO_EXTENSIONS[value.mime] || typeof value.base64 !== 'string' ||
      value.base64.length > Math.ceil(AUDIO_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) fail('语音格式或大小不合法，最多 5 MiB');
  const b=Buffer.from(value.base64,'base64');
  if (b.length<12 || b.length>AUDIO_MAX_BYTES) fail('语音文件为空或超过 5 MiB');
  const matches={
    'audio/wav':b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE',
    'audio/mpeg':b.toString('ascii',0,3)==='ID3'||b[0]===255&&[0xfa,0xfb,0xf2,0xf3,0xe2,0xe3].includes(b[1]),
    'audio/ogg':b.toString('ascii',0,4)==='OggS', 'audio/webm':b.subarray(0,4).toString('hex')==='1a45dfa3',
    'audio/mp4':b.toString('ascii',4,8)==='ftyp',
  };
  if(!matches[value.mime])fail('语音内容与格式不符；SILK 请先通过配置的转换接口转为可播放格式');
  const durationMs=value.durationMs??0;
  if(!Number.isInteger(durationMs)||durationMs<0||durationMs>24*3600000)fail('音频时长信息不合法');
  return {mime:value.mime,base64:b.toString('base64'),durationMs,bytes:b.length};
}
