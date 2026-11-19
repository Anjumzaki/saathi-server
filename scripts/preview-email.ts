/**
 * Renders every transactional email to one HTML page so it can be eyeballed without sending.
 *   npm run mail:preview   ->  tmp/email-preview.html (gitignored)
 * Open that file in a browser. For a true check, send one to yourself: real clients rewrite CSS.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeEmail, type CodePurpose } from '../src/services/emailTemplates';
import { OTP_CONFIG } from '../src/services/otpLogic';

const MINUTES = OTP_CONFIG.ttlMs / 60_000;
const PURPOSES: CodePurpose[] = ['verify', 'signin', 'reset'];

// The real email points the mascot at saathi-app.com. That is not serving it until the site is
// deployed, so the preview swaps in the local file as a data URI: this page is for judging the
// design, and a broken image icon would only be noise. Real clients still need the hosted file.
const mascotData = `data:image/png;base64,${readFileSync(join(__dirname, '..', 'assets', 'email', 'mascot-64-2x.png')).toString('base64')}`;
const withLocalMascot = (html: string): string => html.replace(/https:\/\/saathi-app\.com\/email\/mascot-64-2x\.png/g, mascotData);

// Which theme a client shows depends on the reader's OS, so previewing in whichever mode this
// machine happens to be in only ever checks half the design. These force one each.
const DARK_QUERY = '@media (prefers-color-scheme: dark) {';
const forceLight = (html: string): string => {
  const start = html.indexOf(DARK_QUERY);
  if (start === -1) return html;
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(0, start) + html.slice(i + 1);
  }
  return html;
};
const forceDark = (html: string): string => html.replace(DARK_QUERY, '@media all {');

const frames = PURPOSES.map((p) => {
  const m = codeEmail(p, '402913', MINUTES);
  const frame = (label: string, html: string) =>
    `<figure><figcaption>${label}</figcaption><iframe srcdoc="${withLocalMascot(html).replace(/"/g, '&quot;')}" title="${p} ${label}"></iframe></figure>`;
  return `<section>
  <h2>${p}</h2>
  <p class="subject"><strong>Subject:</strong> ${m.subject}</p>
  <div class="pair">${frame('Light', forceLight(m.html))}${frame('Dark (plum night)', forceDark(m.html))}</div>
  <details><summary>Plain-text part</summary><pre>${m.text.replace(/</g, '&lt;')}</pre></details>
</section>`;
}).join('\n');

const page = `<!DOCTYPE html>
<meta charset="utf-8"><title>Saathi email preview</title>
<style>
  body { font-family: system-ui, sans-serif; background:#efe7ea; margin:0; padding:28px; color:#3D2A32; }
  h1 { font-size:18px; margin:0 0 4px; }
  .note { color:#6D5560; font-size:13px; margin:0 0 24px; }
  section { margin-bottom:34px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:1px; color:#8E6A79; margin:0 0 6px; }
  .subject { font-size:14px; margin:0 0 10px; }
  .pair { display:flex; gap:16px; flex-wrap:wrap; }
  figure { margin:0; flex:1 1 340px; }
  figcaption { font-size:12px; color:#8E6A79; margin-bottom:6px; }
  iframe { width:100%; height:620px; border:1px solid #d9c7ce; border-radius:10px; background:#fff; }
  pre { background:#fff; padding:12px; border-radius:8px; font-size:12px; white-space:pre-wrap; max-width:680px; }
  summary { font-size:13px; cursor:pointer; margin-top:8px; color:#6D5560; }
</style>
<h1>Saathi transactional emails</h1>
<p class="note">Rendered from src/services/emailTemplates.ts. Sample code 402913, ${MINUTES} minute expiry.
The mascot is inlined here for preview; in a real send it loads from saathi-app.com and stays hidden until the reader allows images.</p>
${frames}`;

const out = join(__dirname, '..', 'tmp');
mkdirSync(out, { recursive: true });
const file = join(out, 'email-preview.html');
writeFileSync(file, page, 'utf8');
process.stdout.write(`wrote ${file}\n`);
