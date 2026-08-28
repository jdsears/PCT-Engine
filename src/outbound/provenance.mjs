import { signatureBlock } from '../mail.mjs';
import { reSubject } from './followups.mjs';

// "Where did you get my email address from?"
//
// Chris Wheeler at Pharmaron asked it on 28 August 2026 and the engine had no
// answer ready. This is the answer, and it is a template rather than a model
// prompt on purpose: every other generated sentence describes valves, where
// an imprecise word costs a little credibility. This one describes our own
// data handling to the person whose data it is. It has to be exactly true,
// identical every time, and provably so, which a template gives and a
// paraphrase cannot.
//
// The rule the wording keeps: say where the name came from, say where the
// address came from, say plainly that we do not buy lists, and offer removal
// in the same breath without asking them to justify it. No pitch, no
// re-selling, no "while I have you".

// What each recorded contact source actually was, in plain words. An unknown
// or missing source says so rather than claiming a path we cannot evidence,
// because a confident wrong answer here is worse than an honest partial one.
export const SOURCE_LINES = {
  linkedin: 'Your name and role came from your public LinkedIn profile, and the address itself came from Findymail, a business contact lookup service, matched from your name and your company domain.',
  ch_officers: 'Your name and role came from your company\'s public filings at Companies House, and the address itself came from Findymail, a business contact lookup service, matched from your name and your company domain.',
  post_engagement: 'You came to our attention when you reacted to a post on LinkedIn, your name and role came from your public profile there, and the address itself came from Findymail, a business contact lookup service, matched from your name and your company domain.',
  referral: 'A colleague of yours passed your name on to us as the right person for this, and the address itself came from Findymail, a business contact lookup service, matched from your name and your company domain.',
};
export const SOURCE_UNKNOWN =
  'Your name and role came from public professional sources, most likely your LinkedIn profile or your company\'s Companies House filings, and the address itself came from Findymail, a business contact lookup service, matched from your name and your company domain. I can check the exact record if it would help.';

export function sourceLine(source) {
  return SOURCE_LINES[String(source || '').trim()] || SOURCE_UNKNOWN;
}

// The whole reply. Short by design: a straight answer, the removal offer, and
// nothing else. `firstName` and `sender` are the only variable parts beyond
// the source line, so two people asking the same question on the same day get
// the same answer.
export function provenanceReply({ firstName = null, source = null, sender = null, subject = null } = {}) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const body = [
    greeting,
    '',
    'Fair question, and a straight answer.',
    '',
    sourceLine(source),
    '',
    'We do not buy contact lists and nothing came from a personal source. The reason you were on our list at all is that your role looked like the one that would care about the valve specification side of what we supply.',
    '',
    'If you would rather not hear from us again, just say so and I will take you off entirely. No reason needed, and you will not hear from anyone else here either.',
    '',
    signatureBlock(sender),
  ].join('\n');
  return { subject: reSubject(subject || 'your email'), body };
}

// The confirmation sent once someone has been taken off, when they ask to be.
// Equally short, and it promises only what the suppression actually does.
export function removalConfirmation({ firstName = null, sender = null, subject = null } = {}) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const body = [
    greeting,
    '',
    'Done, you are off our list. You will not hear from us again, by email or on LinkedIn.',
    '',
    'Thanks for saying rather than leaving it.',
    '',
    signatureBlock(sender),
  ].join('\n');
  return { subject: reSubject(subject || 'your email'), body };
}
