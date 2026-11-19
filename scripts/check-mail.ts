/**
 * Checks the SMTP mailbox the server will send OTP emails from.
 *
 *   npm run mail:check                  verify the login only
 *   npm run mail:check you@gmail.com    verify, then send a test message there
 *
 * Reads SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM from the
 * environment. If SMTP_PASS is not set it asks for the password on the
 * terminal, so it never has to live in a file or in shell history.
 * The password is never printed or logged.
 */
import nodemailer from 'nodemailer';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('SMTP_PASS is not set and there is no terminal to ask on'));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function hint(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const code = err.code ?? '';
  const msg = err.message ?? '';
  if (code === 'EAUTH' || err.responseCode === 535) {
    return 'The server refused the login. Use the full email address as SMTP_USER and the mailbox password (not your GoDaddy account password). On Microsoft 365 mailboxes, SMTP AUTH also has to be enabled for the mailbox.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || /timeout/i.test(msg)) {
    return 'Could not open the connection. Check SMTP_HOST and SMTP_PORT, and whether this network blocks outbound port ' + (process.env.SMTP_PORT ?? '465') + '. Port 465 is implicit TLS; 587 is STARTTLS.';
  }
  if (code === 'EENVELOPE' || err.responseCode === 553 || err.responseCode === 550) {
    return 'The server rejected the sender or recipient. MAIL_FROM must use the same address as SMTP_USER.';
  }
  return 'Check the host, port, username and password.';
}

async function main(): Promise<void> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 465);
  const user = process.env.SMTP_USER;
  const to = process.argv[2];

  const missing = [
    ['SMTP_HOST', host],
    ['SMTP_USER', user],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('Missing: ' + missing.join(', '));
    process.exit(1);
  }
  const pass = process.env.SMTP_PASS ?? (await promptHidden('Mailbox password for ' + user + ' (not shown): '));
  if (!pass) {
    console.error('No password given.');
    process.exit(1);
  }
  const from = process.env.MAIL_FROM ?? user!;

  const tx = nodemailer.createTransport({
    host: host!,
    port,
    secure: port === 465,
    requireTLS: port !== 465, // same rule as SmtpMailer: never AUTH over cleartext
    auth: { user: user!, pass },
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });

  console.log(host + ':' + port + ' (' + (port === 465 ? 'implicit TLS' : 'STARTTLS') + ') as ' + user);
  await tx.verify();
  console.log('login accepted');

  if (!to) {
    console.log('No recipient given, so nothing was sent. Pass an address to send a test message.');
    tx.close();
    return;
  }
  const info = await tx.sendMail({
    from,
    to,
    subject: 'Saathi mail check',
    text: 'If you are reading this, the Saathi server can send mail from ' + user + '.',
  });
  console.log('sent to ' + to + ' (' + info.messageId + ')');
  console.log('Check the inbox, and the spam folder: landing in spam means SPF/DKIM/DMARC still need work.');
  tx.close();
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('FAILED: ' + msg);
  console.error(hint(e));
  process.exit(1);
});
