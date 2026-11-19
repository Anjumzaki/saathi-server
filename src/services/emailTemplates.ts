/**
 * Saathi transactional emails.
 *
 * Design sheet 9.1 tokens, ported from mobile/src/theme/colors.ts, and the tone rules from
 * requirements-v1: warm, never alarming, no red, no "failed" language.
 *
 * Email-client constraints this file works within:
 *  - Table layout and inline styles only. Gmail strips <style> in some clients and all of it
 *    when a message is forwarded, so every rule that matters is on the element.
 *  - No web fonts (Gmail drops @font-face), so Poppins is requested and gracefully falls back.
 *  - No images: a blocked-image placeholder is uglier than no image, and a remote logo would
 *    leak an open-tracking signal we have no reason to collect. The mark is drawn with type.
 *  - A dark-mode block is included for clients that honour prefers-color-scheme; clients that
 *    ignore it keep the light design, which is the one that must look right.
 *  - There is deliberately NO "copy code" button. Email clients strip JavaScript, so the clipboard
 *    cannot be touched from a message; a button that looked tappable and did nothing would be
 *    worse than none. What replaces it: the code leads the subject line (so it is readable from a
 *    notification without opening anything), the digits are unbroken in the markup so select-and-
 *    copy and the OS one-time-code detectors both get a clean 6 digits, and the app's own code
 *    screen has a Paste button.
 *  - The mascot is the one remote image. It is hosted on the marketing site rather than attached,
 *    because inline (cid:) attachments are unreliable across providers. Images are blocked by
 *    default for unknown senders, so the email is designed to read perfectly without it.
 */

/** Light tokens (mobile/src/theme/colors.ts: lightColors). */
const C = {
  bg: '#FFF8F4',
  surface: '#FFFFFF',
  surface2: '#F6E3EA',
  primary: '#BF4F7E',
  plum: '#5A1E38',
  text: '#3D2A32',
  body: '#6D5560',
  muted: '#8E6A79',
  border: '#F6E3EA',
  cream: '#F7E7B8',
  goldDeep: '#5C4E10',
} as const;

const FONT = "Poppins,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const SUPPORT = 'support@saathi-app.com';
const SITE = 'https://saathi-app.com';
/** Served from the marketing site; source art in server/assets/email/. */
const MASCOT = `${SITE}/email/mascot-64-2x.png`;

export interface CodeEmail {
  subject: string;
  text: string;
  html: string;
}

/** What the code is for. Drives the subject, the headline and the one-line explanation. */
export type CodePurpose = 'verify' | 'signin' | 'reset';

interface Copy {
  /** The code is prepended, so the whole subject reads "402913 is your Saathi sign-in code". */
  subject: string;
  heading: string;
  lead: string;
  /** Plain-text first line; the code and the footer are appended. */
  textLead: string;
}

const COPY: Record<CodePurpose, Copy> = {
  verify: {
    subject: 'is your Saathi confirmation code',
    heading: 'One step to go',
    lead: 'Enter this code in the app to confirm your email address and finish setting up your Saathi.',
    textLead: 'Enter this code in the app to confirm your email address and finish setting up your Saathi.',
  },
  signin: {
    subject: 'is your Saathi sign-in code',
    heading: 'Welcome back',
    lead: 'Enter this code in the app to sign in.',
    textLead: 'Enter this code in the app to sign in.',
  },
  reset: {
    subject: 'is your Saathi password reset code',
    heading: 'Set a new password',
    lead: 'Enter this code in the app to choose a new password.',
    textLead: 'Enter this code in the app to choose a new password.',
  },
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The digits are never broken up in the markup. Grouping them with a literal space would be
// easier to read but would put a space on the clipboard and stop iOS and Android recognising the
// code for autofill, which costs far more than the readability gains. Letter-spacing does the
// same job visually and leaves the text itself clean.

/**
 * A one-time code email. `minutes` must match the server's real expiry, or the message lies
 * to the reader the moment the two drift apart.
 */
export function codeEmail(purpose: CodePurpose, code: string, minutes: number): CodeEmail {
  const c = COPY[purpose];
  const text = [
    c.textLead,
    '',
    `Code: ${code}`,
    `It expires in ${minutes} minutes.`,
    '',
    "If you didn't ask for this, you can ignore this email — nothing changes until the code is used.",
    '',
    `Saathi · ${SITE}`,
    `Questions? Just reply, or write to ${SUPPORT}`,
  ].join('\n');

  return { subject: `${code} ${c.subject}`, text, html: shell(c.heading, c.lead, code, minutes) };
}

function shell(heading: string, lead: string, code: string, minutes: number): string {
  // Preheader: the grey line shown next to the subject in an inbox list. Without it, clients
  // pull the first body text, which would repeat the heading.
  const preheader = `Your code is ${code} and expires in ${minutes} minutes.`;
  return `<!DOCTYPE html>
<html lang="en" style="margin:0;padding:0;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(heading)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .s-bg { background:#241820 !important; }
    .s-card { background:#3C2B34 !important; border-color:#4E1230 !important; }
    .s-head, .s-code { color:#FFD9E7 !important; }
    .s-text { color:#D3BCC7 !important; }
    .s-muted, .s-foot, .s-foot a { color:#B59AA6 !important; }
    .s-codebox { background:#4E1230 !important; }
    .s-rule { border-color:#4E1230 !important; }
  }
  @media (max-width:620px) {
    .s-pad { padding:28px 22px !important; }
    .s-code { font-size:34px !important; letter-spacing:8px !important; }
  }
</style>
</head>
<body class="s-bg" style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="s-bg" style="background:${C.bg};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <tr>
          <td align="center" style="padding:0 0 10px 0;">
            <img src="${MASCOT}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 0 20px 0;">
            <span class="s-head" style="font-family:${FONT};font-size:22px;font-weight:600;letter-spacing:.5px;color:${C.plum};">Saathi</span>
          </td>
        </tr>

        <tr>
          <td class="s-card" style="background:${C.surface};border:1px solid ${C.border};border-radius:22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="s-pad" style="padding:36px 36px 28px 36px;font-family:${FONT};">

                  <h1 class="s-head" style="margin:0 0 10px 0;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:600;color:${C.plum};">${esc(heading)}</h1>
                  <p class="s-text" style="margin:0 0 26px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${esc(lead)}</p>

                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td class="s-codebox" align="center" style="background:${C.surface2};border-radius:14px;padding:22px 16px;">
                        <!-- text-indent offsets the trailing letter-space so the digits stay optically centred -->
                        <div class="s-code" style="font-family:${FONT};font-size:38px;line-height:1.1;font-weight:600;letter-spacing:10px;text-indent:10px;color:${C.plum};">${esc(code)}</div>
                        <div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};padding-top:10px;">Tap and hold to copy it</div>
                      </td>
                    </tr>
                  </table>

                  <p class="s-muted" style="margin:16px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted};text-align:center;">It expires in ${minutes} minutes.</p>

                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
                    <tr><td class="s-rule" style="border-top:1px solid ${C.border};font-size:0;line-height:0;">&nbsp;</td></tr>
                  </table>

                  <p class="s-muted" style="margin:20px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted};">
                    If you didn't ask for this, you can ignore this email — nothing changes until the code is used.
                  </p>

                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td class="s-foot" align="center" style="padding:22px 16px 0 16px;font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted};">
            <a href="${SITE}" style="color:${C.muted};text-decoration:none;">saathi-app.com</a>
            &nbsp;·&nbsp;
            <a href="mailto:${SUPPORT}" style="color:${C.muted};text-decoration:none;">${SUPPORT}</a>
            <br>Questions? Just reply to this email — a person reads it.
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
