import { describe, expect, it, vi } from 'vitest';
import { codeEmail, type CodePurpose } from '../src/services/emailTemplates';
import { OTP_CONFIG } from '../src/services/otpLogic';
import { ResendMailer } from '../src/services/resendMailer';
import { SmtpMailer } from '../src/services/smtpMailer';

const PURPOSES: CodePurpose[] = ['verify', 'signin', 'reset'];
const MINUTES = OTP_CONFIG.ttlMs / 60_000;

describe('codeEmail', () => {
  it('gives each purpose its own subject, so an inbox never shows two identical ones', () => {
    const subjects = PURPOSES.map((p) => codeEmail(p, '123456', MINUTES).subject);
    expect(new Set(subjects).size).toBe(PURPOSES.length);
    for (const s of subjects) expect(s).toMatch(/saathi/i);
  });

  it('leads the subject with the code, so it can be read from a notification', () => {
    for (const p of PURPOSES) expect(codeEmail(p, '402913', MINUTES).subject).toMatch(/^402913 /);
  });

  it('carries the code and the real expiry in both parts', () => {
    for (const p of PURPOSES) {
      const m = codeEmail(p, '402913', MINUTES);
      expect(m.text).toContain('402913');
      expect(m.text).toContain(`${MINUTES} minutes`);
      expect(m.html).toContain('402913');
      expect(m.html).toContain(`${MINUTES} minutes`);
    }
  });

  it('never ships a placeholder or an unresolved value', () => {
    for (const p of PURPOSES) {
      const m = codeEmail(p, '000000', MINUTES);
      for (const part of [m.subject, m.text, m.html]) {
        expect(part).not.toContain('undefined');
        expect(part).not.toContain('[object');
        expect(part).not.toMatch(/\$\{/);
      }
    }
  });

  it('keeps the text part free of markup, for clients that show it', () => {
    const m = codeEmail('verify', '123456', MINUTES);
    expect(m.text).not.toMatch(/<[a-z]/i);
    expect(m.text).toContain('support@saathi-app.com');
  });

  it('keeps the digits unbroken everywhere, so copy and OS autofill both get a clean code', () => {
    // A literal space inside the code would land on the clipboard and defeat one-time-code detection.
    for (const p of PURPOSES) {
      const m = codeEmail(p, '402913', MINUTES);
      for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/\b402\s+913\b/);
    }
  });

  it('loads nothing from outside saathi-app.com, and only the mascot as an image', () => {
    const { html } = codeEmail('verify', '123456', MINUTES);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/(?!saathi-app\.com)/); // the only host we reference is our own
    expect(html.match(/<img/gi)).toHaveLength(1);
    // Decorative: the wordmark underneath already names the brand, so alt text would just repeat it,
    // and a blocked image should leave no placeholder word behind.
    expect(html).toMatch(/<img[^>]+alt=""/);
  });

  it('reads perfectly with images blocked: nothing load-bearing lives in the mascot', () => {
    const { html } = codeEmail('verify', '123456', MINUTES);
    const withoutImages = html.replace(/<img[^>]*>/gi, '');
    expect(withoutImages).toContain('123456');
    expect(withoutImages).toContain('Saathi');
    expect(withoutImages).toMatch(/10 minutes/);
  });

  it('uses the app palette, so the email and the app look like one product', () => {
    const { html } = codeEmail('verify', '123456', MINUTES);
    expect(html).toContain('#5A1E38'); // plum, headings
    expect(html).toContain('#FFF8F4'); // app background
    expect(html).toContain('#F6E3EA'); // surface2, the code block
    expect(html).toContain('prefers-color-scheme: dark'); // plum-night for clients that honour it
  });

  it('leads the inbox preview with the code rather than repeating the heading', () => {
    const { html } = codeEmail('verify', '123456', MINUTES);
    expect(html).toMatch(/Your code is 123456 and expires in 10 minutes\./);
  });

  it('reassures rather than alarms: no shaming or urgency language', () => {
    for (const p of PURPOSES) {
      const { text, html } = codeEmail(p, '123456', MINUTES);
      for (const part of [text, html]) {
        expect(part).not.toMatch(/\b(urgent|immediately|failed|warning|suspended)\b/i);
      }
      expect(text).toMatch(/ignore this email/i);
    }
  });
});

describe('mailers carry the html part', () => {
  it('SmtpMailer passes html to the transport alongside text', async () => {
    const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({}));
    const m = new SmtpMailer(
      { host: 'h', port: 465, user: 'u', pass: 'p', from: 'Saathi <support@saathi-app.com>' },
      { sendMail } as never,
    );
    await m.send({ to: 'a@b.co', subject: 's', text: 't', html: '<p>h</p>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.co', text: 't', html: '<p>h</p>' }));
  });

  it('SmtpMailer omits html entirely when there is none', async () => {
    const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({}));
    const m = new SmtpMailer({ host: 'h', port: 465, user: 'u', pass: 'p', from: 'f' }, { sendMail } as never);
    await m.send({ to: 'a@b.co', subject: 's', text: 't' });
    expect(Object.keys(sendMail.mock.calls[0]![0])).not.toContain('html');
  });

  it('ResendMailer puts html in the request body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }) as Response);
    await new ResendMailer('key', 'f', fetchImpl as unknown as typeof fetch).send({ to: 'a@b.co', subject: 's', text: 't', html: '<p>h</p>' });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ to: ['a@b.co'], text: 't', html: '<p>h</p>' });
  });
});
