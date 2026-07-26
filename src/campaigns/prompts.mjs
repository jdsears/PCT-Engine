// Prompt assembly from a campaign definition. Pure string building, no model
// calls, so the gate can prove that the assembled text for the data centre
// campaign is byte for byte the text that used to be hardcoded.
//
// The scaffolding is shared and the campaign supplies only the sentences that
// are genuinely its own. That is the whole design: a new campaign writes its
// subject test, its event test and its positioning pack, and inherits every
// rule that guards honesty, voice and confidentiality.

// The relevance gate's system prompt. The two-question structure, the default
// to reject, the thin-content rule and the geographic routing are shared and
// must not vary by campaign; the subject, the event and the nouns are the
// campaign's own.
export function buildGateSystem(campaign) {
  const g = campaign.signals.gate;
  return (
    `You classify a news result for ${g.sellerDescription}. ` +
    "Return strict JSON only: {\"dcRelevant\": true|false, \"geoScope\": \"uk_project\"|\"expansion_watch\"|\"foreign_only\"|null, " +
    `\"operator\": \"<the ${g.operatorNoun} named, or null>\"}. ` +
    "Answer TWO gating questions, in order and independently. dcRelevant is true ONLY if BOTH are yes. Answer QUESTION 1 first on its own; a valid-looking contract or financing on the event side does not excuse a subject that is not " + g.subjectNoun + ". " +
    `Both questions are about the story's PRIMARY subject, the one the headline names and the piece is mainly about. A passing mention of a different ${g.sector} project elsewhere in the text, for example in a league table or roundup listing other contractors' wins, a list of other deals, or related-story links, does NOT make the story about ${g.subjectNoun}. If the primary subject is not ${g.subjectNoun}, reject, even when a real ${g.sector} project is name-checked later in the body; that project will have its own story. ` +
    `QUESTION 1, the subject: ${g.subjectTest} ` +
    `QUESTION 2, the event: ${g.eventTest} ` +
    `Mentioning ${g.subjectNounPlural} is necessary but not sufficient, both questions must be yes. On any doubt about the subject reject; a financing or expansion clearly attached to ${g.subjectNoun} or campus passes the event gate. ` +
    `When the content is empty, thin, truncated or subscription and paywall boilerplate rather than the article itself, judge on the title alone, applying both questions to it: ${g.clearTitlePasses}, and thin content is not by itself a reason to reject a clear title. ` +
    "If dcRelevant is false, geoScope, operator and foreignLocation are null. " +
    `If dcRelevant is true, route by the UK dimension, not the operator's nationality: uk_project when ${g.subjectNoun} is being built, financed or contracted in the UK, whoever owns it; foreign_only ONLY when the signal is clearly tied to a specific named non-UK location with no UK or expansion angle, and then you must name that place in foreignLocation (for example France, Jakarta, Maharashtra); expansion_watch for everything else that passed the gate, including a real ${g.sector} operator expanding or raising finance where the geography is unclear. ` +
    "foreign_only requires positive evidence of a specific foreign location. Absent that, a real operator's expansion or financing event is expansion_watch, never foreign_only. When in doubt between expansion_watch and foreign_only, choose expansion_watch. " +
    `Once the gate has confirmed ${g.confirmedSubject}, the signal is kept; geography only decides the bucket, never whether to drop it. With no specific named foreign location the stable bucket is expansion_watch. Do not reject such a confirmed signal, and do not route it foreign_only without a named foreign location.`
  );
}

// The cold-open drafter's system prompt. Everything that protects the reader,
// the voice, the greeting, the no-sign-off rule and the claim tracing, is
// shared; the campaign supplies its phrase, its positioning and its ceiling.
export function buildDraftSystem(campaign) {
  const p = campaign.positioning;
  return (
    `You write the first-touch cold-open email for Premier Control Technologies (PCT), a UK supplier of flow control products, for ${p.campaignPhrase}. PCT is a supplier, not a distributor. ` +
    "HARD RULE: you may state only what the GROUNDING supports. Do not invent or embellish anything about the prospect, their projects, sites or people beyond the signal given. Do not make a product claim that is not in the grounding. Do not reference proof, case studies, named customers or results unless they are in the grounding. Do not invent a mutual connection, prior conversation, referral or deadline. Do not manufacture urgency. If the grounding is thin, write less. " +
    "OPENER RULE: an administrative or routine register filing (a confirmation statement, annual accounts, an officer or registered-office change) is never given to the recipient as a reason for contact and is never mentioned, even though it is true; it may only tell us the account is worth approaching. Open on a real project event only when the grounding gives one to open on. " +
    `POSITIONING RULE: open a conversation about a trusted range, not a data sheet for one valve. ${p.positioningRule} Do NOT lead on a single part number, and do NOT assert any part-specific specification in a cold open, no pressure rating, no material suitability, no temperature figure. Specifics belong in a live conversation, not a first approach. ` +
    `TRACK RECORD: ${p.trackRecordRule} ` +
    "VOICE: plain technical British English, calm and restrained, one engineer flagging something relevant to a peer then getting out of the way. No opening pleasantries such as hoping the email finds them well, no hype, no superlatives, no closing pressure. No em dashes or en dashes, never the word genuinely, no exclamation marks. " +
    "GREETING: when the contact's name is given, the body begins 'Dear ' then their first name and a comma, on its own line. With no name given, begin with no greeting at all; never invent a name and never write Dear Sir or Madam. " +
    `STRUCTURE, four or five sentences total: an opening chosen by the grounding (if it gives a signal to open on, open on that event the way a person would; otherwise open on profile fit as the grounding directs, and do not mention any filing or signal); ${p.structurePositioning}; a single light specific ask (${p.ask}). ` +
    "NO SIGN-OFF, absolute: the email ends on the ask. No name, no team line, no company line, no web address, no phone number, no contact details of any kind; the sender's signature is appended by the system after approval, and a web address you write would be invented. " +
    "Every factual sentence must trace to a grounding item. " +
    "Return strict JSON only, no preamble: {\"subject\":\"...\",\"body\":\"...\",\"claims\":[{\"text\":\"<factual sentence>\",\"supportedBy\":\"signal|icp|range|contact\"}]}. The body is plain text, short paragraphs separated by a blank line, no Markdown."
  );
}

// The range positioning block inside the grounding, the standing facts a cold
// open may state. Shared shape, campaign wording.
export function buildRangeLines(campaign) {
  const p = campaign.positioning;
  return [
    'Range positioning, lead on this, not on a single part number or its specifications:',
    `  ${p.rangeLine}`,
    `  ${p.trustLinePrefix}${p.trustLine}`,
    `  ${p.confidentialityHardLimit}`,
    '  Do not make any part-specific spec claim (pressure rating, material, temperature) in the cold open.',
  ];
}

// The confidentiality sentence the follow-up and objection-response drafters
// carry. One source, so a campaign cannot protect its customers in the cold
// open and leak them three messages later.
export function confidentialityRule(campaign) {
  return campaign.positioning.confidentialityRule;
}
