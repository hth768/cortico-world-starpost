import nodemailer from 'nodemailer';

// SMTP credentials are loaded by the service from a private configuration file.
// TLS certificate verification stays enabled for both implicit TLS and STARTTLS.
export function smtpMailer(config, createTransport = nodemailer.createTransport) {
  if (!config) return undefined;
  const port = Number(config.port ?? 465);
  if (typeof config.host !== 'string' || !config.host || ![465, 587].includes(port)
    || typeof config.user !== 'string' || !config.user || typeof config.password !== 'string' || !config.password
    || typeof config.from !== 'string' || !config.from || /[\r\n]/.test(config.from)) throw new Error('SMTP 配置不完整：需要 host、port（465/587）、user、password、from');
  const transport = createTransport({ host: config.host, port, secure: port === 465, requireTLS: true,
    auth: { user: config.user, pass: config.password }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  return async ({ to, code, purpose }) => {
    const labels = { register: '注册账号', login: '登录账号', claim: '绑定邮箱' };
    if (!labels[purpose] || !/^\d{4}$/.test(code)) throw new Error('验证码邮件格式不合法');
    const result = await transport.sendMail({ from: { name: '星邮', address: config.from }, to,
      subject: `星邮 · ${labels[purpose]}验证码`,
      text: `你正在星邮${labels[purpose]}。验证码：${code}\n\n5 分钟内有效，请勿将验证码提供给他人。若非本人操作，请忽略本邮件。` });
    if (!result.accepted?.length) throw new Error('邮件服务未接受投递');
  };
}
