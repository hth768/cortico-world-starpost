import nodemailer from 'nodemailer';
import { setTimeout as delay } from 'node:timers/promises';

const smtpError = code => Object.assign(new Error('邮件服务暂时不可用'), { code });
const errorCode = error => ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EENVELOPE', 'EMESSAGE', 'EBUSY', 'ECLOSED'].includes(error?.code) ? error.code : 'ESMTP';
// Never log provider response/message: these can contain addresses, credentials or mail contents.
const report = event => process.stderr.write(`${JSON.stringify({ event: 'smtp_delivery', ...event })}\n`);
const retryable = error => error?.code !== 'EAUTH' && (
  Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 500
  || ['CONN', 'EHLO', 'HELO', 'STARTTLS'].includes(error?.command) && ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(error?.code));

// SMTP credentials are loaded by the service from a private configuration file.
// TLS certificate verification stays enabled for both implicit TLS and STARTTLS.
export function smtpMailer(config, createTransport = nodemailer.createTransport, { log = report, sleep = delay, deadlineMs = 20000 } = {}) {
  if (!config) return undefined;
  const port = Number(config.port ?? 465);
  if (typeof config.host !== 'string' || !config.host || ![465, 587].includes(port)
    || typeof config.user !== 'string' || !config.user || typeof config.password !== 'string' || !config.password
    || typeof config.from !== 'string' || !config.from || /[\r\n]/.test(config.from)) throw new Error('SMTP 配置不完整：需要 host、port（465/587）、user、password、from');
  const options = { host: config.host, port, secure: port === 465, requireTLS: true,
    auth: { user: config.user, pass: config.password }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    pool: true, maxConnections: 1, maxMessages: 50, maxRequeues: 0, idleTimeout: 30000,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false };
  // Two reusable lanes, no unbounded SMTP queue. Closing a busy Nodemailer pool
  // drains its in-flight send; keep that lane occupied until it actually settles.
  const lanes = [{ busy: false }, { busy: false }];
  let closed = false;
  const record = event => { try { log(event); } catch { /* Logging must not invalidate an accepted code. */ } };
  const reset = lane => { lane.transport?.close?.(); lane.transport = undefined; };
  const send = async ({ to, code, purpose }) => {
    const labels = { register: '注册账号', login: '登录账号', claim: '绑定邮箱' };
    if (!Object.hasOwn(labels, purpose) || typeof code !== 'string' || !/^\d{4}$/.test(code)) throw new Error('验证码邮件格式不合法');
    if (closed) throw smtpError('ECLOSED');
    const lane = lanes.find(item => !item.busy);
    if (!lane) { record({ outcome: 'busy', purpose }); throw smtpError('EBUSY'); }
    lane.busy = true;
    const started = Date.now();
    let timer, stopped = false, attempts = 0;
    const envelope = { from: { name: '星邮', address: config.from }, to,
      subject: `星邮 · ${labels[purpose]}验证码`,
      text: `验证码：【${code}】\n（只需填写括号内的四位数字）\n\n你正在星邮${labels[purpose]}。\n有效期：五分钟。请以最新成功发送的邮件为准。\n请勿将验证码提供给他人。若非本人操作，请忽略本邮件。`,
      html: `<!doctype html><html lang="zh-CN"><body style="margin:0;padding:24px;font-family:sans-serif;color:#202334;background:#f5f6fa"><main style="max-width:480px;margin:auto;padding:28px;background:#fff;border-radius:20px"><h1 style="font-size:22px">星邮 · ${labels[purpose]}</h1><p>你的验证码</p><p style="font-family:monospace;font-size:36px;font-weight:bold;background:#eef1ff;padding:20px;text-align:center;border-radius:12px">${code}</p><p>只需填写上方四位数字。</p><p><strong>有效期：五分钟。</strong></p><p>请以最新成功发送的邮件为准。请勿将验证码提供给他人。</p><p style="color:#666">若非本人操作，请忽略本邮件。</p></main></body></html>` };
    const deliver = async () => {
      for (attempts = 1; attempts <= 2; attempts++) {
        if (stopped || closed) throw smtpError('ECLOSED');
        lane.transport ??= createTransport(options);
        try {
          const result = await lane.transport.sendMail(envelope);
          if (!result.accepted?.length) throw smtpError('EENVELOPE');
          return;
        } catch (error) {
          // Retry a temporary explicit rejection or pre-message connection failure once.
          // An ambiguous DATA/ACK disconnect must not be retried automatically.
          if (stopped || closed || attempts === 2 || !retryable(error)) throw error;
          reset(lane);
          await sleep(400);
        }
      }
    };
    const delivery = deliver();
    try {
      await Promise.race([delivery, new Promise((_, reject) => {
        timer = setTimeout(() => { stopped = true; reset(lane); reject(smtpError('ETIMEDOUT')); }, deadlineMs);
      })]);
      record({ outcome: 'accepted', purpose, attempts, elapsedMs: Date.now() - started });
    } catch (error) {
      reset(lane);
      record({ outcome: 'failed', purpose, attempts, elapsedMs: Date.now() - started, code: errorCode(error),
        ...(Number.isInteger(error?.responseCode) ? { responseCode: error.responseCode } : {}) });
      throw Object.assign(smtpError(errorCode(error)), { status: 503 });
    } finally {
      stopped = true; clearTimeout(timer);
      // Do not admit a replacement while the provider is still finishing a timed-out send.
      delivery.then(() => { lane.busy = false; }, () => { lane.busy = false; });
    }
  };
  send.close = () => { closed = true; for (const lane of lanes) reset(lane); };
  return send;
}
