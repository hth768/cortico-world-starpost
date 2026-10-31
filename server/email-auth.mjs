import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const derive = promisify(scrypt);
const fail = (text, status = 400) => { const error = new Error(text); error.status = status; throw error; };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const hashToken = value => createHash('sha256').update(value).digest('hex');
export function emailSecret(path) {
  try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const secret = readFileSync(path);
  if (secret.length !== 32) throw new Error('邮箱验证密钥文件损坏');
  return secret;
}
export function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) fail('请填写有效的邮箱地址');
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  if (extra !== undefined || !local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain || !domain.includes('.')
    || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail('请填写有效的邮箱地址');
  return email;
}
export function humanNickname(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 32 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('昵称须为 1–32 个字符，不能包含控制字符');
  return value.trim();
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('密码须为 8–128 个字符');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${salt}$${key.toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const valid = /^scrypt\$32768\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored ?? '');
  // Unknown accounts also run the KDF; the HTTP reply does not disclose account existence.
  const salt = valid?.[1] ?? '0'.repeat(32);
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return Boolean(valid && equal(key.toString('hex'), valid[2]));
}

export class AuthThrottle {
  constructor(store, clock = Date.now) { Object.assign(this, { store, clock }); }
  take(entries) {
    const now = this.clock();
    const allowed = this.store.transaction(() => {
      const rows = entries.map(([name, max, duration]) => {
        const key = hashToken(name), old = this.store.get('authRates', key);
        return { key, max, row: old && old.expiresAt > now ? old : { count: 0, expiresAt: now + duration } };
      });
      if (rows.some(({ row, max }) => row.count >= max)) return false;
      for (const { key, row } of rows) this.store.put('authRates', key, { ...row, count: row.count + 1, at: new Date(row.expiresAt).toISOString() });
      this.store.statement("DELETE FROM documents WHERE collection='authRates' AND at<?").run(new Date(now).toISOString());
      return true;
    });
    if (!allowed) fail('操作过于频繁，请稍后再试', 429);
  }
}

// This class owns its transactions. Do not wrap it in a caller transaction:
// failed guesses must remain recorded even when an application action fails.
export class EmailVerification {
  constructor(store, { secret, sendMail, clock = Date.now }) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('邮箱验证密钥至少需要 32 字节');
    Object.assign(this, { store, secret, sendMail, clock });
    this.throttle = new AuthThrottle(store, clock);
  }
  digest(value) { return createHmac('sha256', this.secret).update(JSON.stringify(value)).digest('hex'); }
  async send({ email: input, purpose, subject = '', remote }) {
    const email = emailAddress(input);
    if (!['register', 'login', 'claim'].includes(purpose) || purpose === 'claim' && !/^\d{5,12}H$/.test(subject)) fail('验证码用途不合法');
    if (purpose !== 'claim') subject = '';
    if (typeof this.sendMail !== 'function') fail('邮箱服务尚未配置，请稍后重试', 503);
    this.throttle.take([[`mail:cooldown:${email}`, 1, 60000], [`mail:email:${email}`, 6, 3600000], [`mail:ip:${remote}`, 30, 3600000], ['mail:global', 1000, 3600000]]);
    const id = randomUUID(), code = String(randomInt(10000)).padStart(4, '0'), now = this.clock();
    const slot = this.digest(['slot', email, purpose, subject]);
    const row = { id, slot, email, purpose, subject, codeHash: this.digest([id, email, purpose, subject, code]),
      expiresAt: now + 300000, attempts: 0, ready: false, at: new Date(now + 300000).toISOString() };
    this.store.transaction(() => {
      this.store.statement("DELETE FROM documents WHERE collection='emailChallenges' AND (key=? OR at<=?)").run(slot, new Date(now).toISOString());
      this.store.put('emailChallenges', slot, row);
    });
    try { await this.sendMail({ to: email, code, purpose, expiresMinutes: 5 }); }
    catch {
      this.store.transaction(() => { if (this.store.get('emailChallenges', slot)?.id === id) this.store.remove('emailChallenges', slot); });
      fail('验证码邮件发送失败，请稍后重试', 503);
    }
    this.store.transaction(() => {
      const current = this.store.get('emailChallenges', slot);
      if (current?.id === id) this.store.put('emailChallenges', slot, { ...current, ready: true });
    });
    // Never include the code, its digest, or SMTP credentials in responses/logs.
    return { challengeId: id, expiresIn: 300, retryAfter: 60, message: '验证码已发送，5 分钟内有效' };
  }
  consume({ email: input, purpose, subject = '', challengeId, code, remote }, action) {
    const email = emailAddress(input);
    this.throttle.take([[`verify:email:${email}`, 20, 3600000], [`verify:ip:${remote}`, 100, 3600000]]);
    if (!['register', 'login', 'claim'].includes(purpose)) fail('验证码用途不合法');
    if (purpose !== 'claim') subject = '';
    const slot = this.digest(['slot', email, purpose, subject]);
    const verified = this.store.transaction(() => {
      const row = this.store.get('emailChallenges', slot);
      if (!row || !row.ready || row.id !== challengeId || row.expiresAt <= this.clock() || row.attempts >= 5) return false;
      const matches = typeof code === 'string' && /^\d{4}$/.test(code) && equal(row.codeHash, this.digest([row.id, email, purpose, subject, code]));
      if (!matches) { this.store.put('emailChallenges', slot, { ...row, attempts: row.attempts + 1 }); return false; }
      return true;
    });
    if (!verified) fail('验证码错误、已失效或尝试次数过多');
    return this.store.transaction(() => {
      // Synchronous application callback and consumption commit together.
      const current = this.store.get('emailChallenges', slot);
      if (!current || current.id !== challengeId) fail('验证码已失效');
      const result = action(email);
      if (result && typeof result.then === 'function') throw new Error('验证码消费回调必须同步');
      this.store.remove('emailChallenges', slot);
      return result;
    });
  }
}
