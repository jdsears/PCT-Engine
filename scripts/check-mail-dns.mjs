#!/usr/bin/env node
// Deliverability basics for the sending domain: SPF, DKIM and DMARC, checked
// with plain DNS lookups and no keys. Cold mail from a domain missing any of
// the three lands in spam regardless of what the email says, so this runs
// before the first real send and any time deliverability looks off.
//
//   node scripts/check-mail-dns.mjs                 domain from ENGINE_MAILBOX in .env
//   node scripts/check-mail-dns.mjs pctflow.com     or name the domain directly
import { resolveTxt, resolveCname } from 'node:dns/promises';

const arg = process.argv[2];
const fromEnv = String(process.env.ENGINE_MAILBOX || '').split('@')[1];
const domain = (arg || fromEnv || '').trim().toLowerCase();
if (!domain) {
  console.error('No domain. Pass one, or run with --env-file=.env so ENGINE_MAILBOX provides it.');
  process.exit(1);
}

const flat = records => records.map(r => r.join('')).filter(Boolean);
let failures = 0;
const verdict = (ok, label, detail) => {
  console.log(`${ok ? '  ok   ' : '  MISSING'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`Mail DNS for ${domain}\n`);

// SPF: one TXT record naming the permitted senders. Microsoft 365 sends need
// include:spf.protection.outlook.com.
try {
  const txt = flat(await resolveTxt(domain)).filter(t => /^v=spf1\b/i.test(t));
  if (!txt.length) verdict(false, 'SPF', 'no v=spf1 TXT record on the domain');
  else {
    const spf = txt[0];
    const hasM365 = /include:spf\.protection\.outlook\.com/i.test(spf);
    verdict(hasM365, 'SPF', hasM365 ? spf : `record exists but does not include spf.protection.outlook.com: ${spf}`);
    if (txt.length > 1) verdict(false, 'SPF count', `${txt.length} v=spf1 records found; more than one is itself a fail`);
  }
} catch { verdict(false, 'SPF', 'lookup failed'); }

// DKIM: Microsoft 365 signs with two selectors, published as CNAMEs.
for (const sel of ['selector1', 'selector2']) {
  try {
    const target = await resolveCname(`${sel}._domainkey.${domain}`);
    verdict(target.length > 0, `DKIM ${sel}`, target[0] || '');
  } catch { verdict(false, `DKIM ${sel}`, `no CNAME at ${sel}._domainkey.${domain}; enable DKIM signing in the Defender portal`); }
}

// DMARC: the policy record. p=none is a start; quarantine or reject is the goal
// once SPF and DKIM have settled.
try {
  const txt = flat(await resolveTxt(`_dmarc.${domain}`)).filter(t => /^v=DMARC1\b/i.test(t));
  if (!txt.length) verdict(false, 'DMARC', `no TXT record at _dmarc.${domain}`);
  else {
    const p = (txt[0].match(/\bp=(\w+)/i) || [])[1] || 'unset';
    verdict(true, 'DMARC', `${txt[0]}${p === 'none' ? '  (p=none is fine to start; move to quarantine once aligned)' : ''}`);
  }
} catch { verdict(false, 'DMARC', 'lookup failed'); }

console.log(failures
  ? `\n${failures} item(s) need attention before real prospect sends. These are one-time DNS records, set where ${domain} is hosted.`
  : '\nAll three are in place. Deliverability rests on volume discipline from here, which the engine already enforces.');
process.exit(failures ? 2 : 0);
