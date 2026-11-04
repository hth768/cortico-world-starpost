import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smtpMailer } from '../server/mail.mjs';
import { EmailVerification } from '../server/email-auth.mjs';
import { StarpostStorage } from '../server/storage.mjs';

const config = { host: 'smtp.example.com', port: 465, user: 'sender@example.com', password: 'never-log-password', from: 'sender@example.com' };
const mail = { to: 'person@example.com', code: '0042', purpose: 'register' };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; });return { promise, resolve, reject }; };
const quiet = { log: () => {}, sleep: async () => {} };

test('邮件摘要与 HTML 均将前导零验证码单独展示，有效期不含阿拉伯数字', async () => {
  let options, message;
  const send = smtpMailer(config, o => { options=o;return { sendMail: async m => { message=m;return {accepted:[mail.to]}; } }; }, quiet);
  await send(mail);send.close();
  assert.equal(options.pool,true);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.requireTLS,true);
  assert.deepEqual(message.text.match(/\d+/g),['0042']);assert.deepEqual(message.html.match(/>\d+</g),['>0042<']);
  assert.ok(message.text.startsWith('验证码：【0042】\n'));assert.match(message.text,/有效期：五分钟/);
  assert.match(message.html,/只需填写上方四位数字/);assert.doesNotMatch(message.html,/<img|<script|https?:/);
});

test('仅安全的临时失败重试同一封码；鉴权失败、永久拒绝、DATA 结果不明确不重试', async () => {
  for(const [error,expected] of [
    [{code:'ECONNECTION',command:'CONN'},2], [{code:'EMESSAGE',command:'DATA',responseCode:451},2],
    [{code:'EAUTH',responseCode:454},1], [{code:'EENVELOPE',responseCode:550},1], [{code:'ETIMEDOUT',command:'DATA'},1]
  ]) {
    let calls=0,closed=0;const envelopes=[],logs=[];
    const send=smtpMailer(config,()=>({close(){closed++;},async sendMail(value){envelopes.push(value);if(++calls===1)throw Object.assign(new Error('never-log-password person@example.com 0042'),error);return {accepted:[mail.to]};}}),{...quiet,log:e=>logs.push(e)});
    if(expected===2)await send(mail);else await assert.rejects(send(mail));
    assert.equal(calls,expected);if(expected===2)assert.equal(envelopes[0],envelopes[1]);
    assert.doesNotMatch(JSON.stringify(logs),/never-log-password|person@example|0042/);assert.ok(closed>0);send.close();
  }
});

test('最多两份邮件同时发送，不积压长队列；空闲连接复用并可关闭', async () => {
  const pending=[],transports=[];
  const send=smtpMailer(config,()=>{const t={closed:false,close(){this.closed=true},sendMail(){const d=deferred();pending.push(d);return d.promise;}};transports.push(t);return t;},quiet);
  const a=send(mail),b=send(mail);await assert.rejects(send(mail),{code:'EBUSY'});assert.equal(pending.length,2);
  pending[0].resolve({accepted:[mail.to]});await a;
  const c=send(mail);assert.equal(transports.length,2,'reuse first lane');pending[2].resolve({accepted:[mail.to]});pending[1].resolve({accepted:[mail.to]});await Promise.all([b,c]);
  send.close();assert.ok(transports.every(t=>t.closed));await assert.rejects(send(mail),{code:'ECLOSED'});
});

test('总发送时限结束 HTTP 等待；迟到的拒绝不会重试或影响另一连接', async () => {
  let calls=0,closed=0;const hanging=deferred(),logs=[];
  const send=smtpMailer(config,()=>({close(){closed++},sendMail(){return ++calls===1?hanging.promise:Promise.resolve({accepted:[mail.to]});}}),{...quiet,deadlineMs:15,log:e=>logs.push(e)});
  await assert.rejects(send(mail),{code:'ETIMEDOUT'});assert.ok(closed>0);
  await send(mail);hanging.reject(Object.assign(new Error('disconnected'),{code:'ECONNECTION',command:'CONN'}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.deepEqual(logs.map(x=>x.outcome),['failed','accepted']);send.close();
});

test('超时但仍在发送的连接占用原有名额，防止后台连接越积越多', async () => {
  const gates=[];
  const send=smtpMailer(config,()=>({close(){},sendMail(){const d=deferred();gates.push(d);return d.promise}}),{...quiet,deadlineMs:15});
  await assert.rejects(send(mail),{code:'ETIMEDOUT'});await assert.rejects(send(mail),{code:'ETIMEDOUT'});
  await assert.rejects(send(mail),{code:'EBUSY'});assert.equal(gates.length,2);
  for(const d of gates)d.resolve({accepted:[mail.to]});await new Promise(resolve=>setImmediate(resolve));send.close();
});

function verificationFixture(t,sendMail){
  const dir=mkdtempSync(join(tmpdir(),'starpost-email-'));
  const store=new StarpostStorage({dbFile:join(dir,'auth.sqlite')});let now=Date.parse('2026-11-04T12:00:00+08:00');
  const verification=new EmailVerification(store,{secret:Buffer.alloc(32,42),sendMail,clock:()=>now});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const input={email:mail.to,purpose:'register',remote:'local-test'};
  return {verification,store,input,advance(ms){now+=ms},consume(result,code){return verification.consume({...input,challengeId:result.challengeId,code},()=>true)}};
}

test('发送中不能验证或并发重发；SMTP 接受后才开始完整五分钟期限', async t => {
  const gate=deferred();let sent;
  const f=verificationFixture(t,async m=>{sent=m;await gate.promise});
  const sending=f.verification.send(f.input);assert.equal(f.store.list('emailChallenges').length,0);
  f.advance(61000);await assert.rejects(f.verification.send(f.input),/正在发送/);
  gate.resolve();const result=await sending;
  assert.equal(result.expiresIn,300);assert.equal(f.store.list('emailChallenges')[0].ready,true);
  assert.doesNotMatch(JSON.stringify(f.store.list('emailChallenges')),new RegExp(`"code":"${sent.code}"`));
  f.advance(299999);assert.equal(f.consume(result,sent.code),true);
  assert.throws(()=>f.consume(result,sent.code),/失效/);
});

test('重发失败保留上一份验证码与错误次数，成功重发则替换旧码', async t => {
  let sent,fail=false;
  const f=verificationFixture(t,async m=>{if(fail)throw Error('smtp');sent=m;});
  const first=await f.verification.send(f.input),firstCode=sent.code;
  assert.throws(()=>f.consume(first,'xxxxx'),/验证码错误/);
  const before=f.store.list('emailChallenges')[0];f.advance(61000);fail=true;
  await assert.rejects(f.verification.send(f.input),/发送失败或超时/);
  assert.deepEqual(f.store.list('emailChallenges')[0],before);assert.equal(f.consume(first,firstCode),true);
  fail=false;f.advance(61000);const second=await f.verification.send(f.input),secondCode=sent.code;
  f.advance(61000);const third=await f.verification.send(f.input);
  assert.throws(()=>f.consume(second,secondCode),/失效/);assert.equal(f.consume(third,sent.code),true);
});

test('接受后五分钟到期，无收件人被接受时不会创建可用验证码', async t => {
  let sent;const f=verificationFixture(t,async m=>{sent=m;});const result=await f.verification.send(f.input);
  f.advance(300000);assert.throws(()=>f.consume(result,sent.code),/失效/);
  const send=smtpMailer(config,()=>({sendMail:async()=>({accepted:[]})}),quiet);
  await assert.rejects(send(mail),{code:'EENVELOPE'});send.close();
});
