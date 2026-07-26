import { CloudAdapter, ConfigurationBotFrameworkAuthentication, ActivityHandler } from 'botbuilder';
import { ask } from './answer.mjs';
import { pool } from './db.mjs';
import { createConversationStore } from './teamsState.mjs';

// The Knowledge Co-Pilot inside Microsoft Teams, personal chat only. It reuses
// the existing ask() pipeline, and carries short-term conversation state in
// memory (see teamsState.mjs) so follow-up questions keep their thread and a
// part-number build works across turns, exactly as in the web chat. Nothing is
// persisted: the conversation id is an in-memory routing key only, never
// written to the database or the logs.
//
// IMPORTANT: the /api/teams/messages route in server.mjs is exempt from the
// access-gate cookie check on purpose. Its protection is Bot Framework token
// validation, performed by the adapter below: every incoming request carries a
// JWT that the adapter validates against this bot's single-tenant registration,
// and a request that fails validation never reaches ask(). The shared access
// key does not apply, because Teams, not a browser, is the caller.

const APP_ID = process.env.TEAMS_BOT_APP_ID || '';
const APP_PASSWORD = process.env.TEAMS_BOT_APP_PASSWORD || '';
export const teamsConfigured = () => Boolean(APP_ID && APP_PASSWORD);

if (!teamsConfigured()) {
  console.warn('TEAMS_BOT_APP_ID/TEAMS_BOT_APP_PASSWORD not set: the Teams endpoint will reject requests until they are.');
}

// Single-tenant bot, validated against the PCT tenant. Built only when
// configured: the SDK requires the app id for a single-tenant bot, so before
// registration the adapter stays null and the endpoint reports not configured,
// rather than blocking the whole service from starting.
let adapter = null;
if (teamsConfigured()) {
  adapter = new CloudAdapter(new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: APP_ID,
    MicrosoftAppPassword: APP_PASSWORD,
    MicrosoftAppType: 'SingleTenant',
    MicrosoftAppTenantId: process.env.MS_TENANT_ID || '',
  }));
  // Errors speak in the house voice: what happened and what to do, no apology.
  adapter.onTurnError = async (context, error) => {
    console.error('teams turn error:', error?.message || error);
    await context.sendActivity('Something went wrong reaching the co-pilot. Please try again in a moment.');
  };
}

// One compact line from the cited sources only, with a page where known, for
// example "Sources: CV3000.pdf p3 | Project Pursuit p8". Nothing at all when
// the answer declined, since there are no citations to show.
function sourcesLine(result) {
  const cited = result.citations || [];
  if (!cited.length) return '';
  const parts = cited.map(c => `${c.title}${c.page ? ` p${c.page}` : ''}`);
  return `\n\nSources: ${parts.join(' · ')}`;
}

// The full Teams reply: the answer, then the sources line when there is one.
// Exported so the rendering can be checked without a live bot.
export function composeReply(result) {
  return `${result.answer}${sourcesLine(result)}`;
}

// Teams expects a timely reply, so the answer is bounded. A slow model run
// reports back rather than leaving the chat waiting.
const ASK_TIMEOUT_MS = 25000;
const MAX_QUESTION_CHARS = 2000;

const conversations = createConversationStore();

const bot = new ActivityHandler();
bot.onMessage(async (context, next) => {
  const question = (context.activity.text || '').replace(/<at>.*?<\/at>/g, '').trim();
  if (question) {
    if (question.length > MAX_QUESTION_CHARS) {
      await context.sendActivity('That message is too long for the co-pilot. Please ask it in a shorter form.');
      await next();
      return;
    }
    await context.sendActivity({ type: 'typing' });
    const convId = context.activity.conversation?.id || null;
    const { history, configState, quoteState } = conversations.get(convId);
    try {
      const result = await Promise.race([
        ask(question, { history, configState, quoteState }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ask-timeout')), ASK_TIMEOUT_MS)),
      ]);
      conversations.remember(convId, question, result);
      await context.sendActivity(composeReply(result));
      logTeamsQuery(question, result).catch(e => console.error('teams query log failed:', e.message));
    } catch (e) {
      if (e.message === 'ask-timeout') {
        await context.sendActivity('The co-pilot took too long to answer. Please ask again.');
      } else {
        console.error('teams ask failed:', e.message);
        await context.sendActivity('The co-pilot could not answer that just now. Please try again in a moment.');
      }
    }
  }
  await next();
});

// Usage logging with channel = teams, after the reply, so it never delays or
// fails an answer. No user identity is stored: not the name, the AAD object id,
// nor the conversation id. Attribution is a deliberate future decision to take
// with PCT, not a default, and is intentionally absent here.
async function logTeamsQuery(question, result) {
  await pool.query(
    `INSERT INTO copilot_queries
       (question, detected_filters, declined, citations_used, sources_offered, latency_ms, channel)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6, 'teams')`,
    [question, JSON.stringify(result.filters || {}), !!result.declined,
     JSON.stringify(result.citationsUsed || []), result.sourcesOffered ?? null, result.latencyMs ?? null]);
}

// The Express handler. The adapter validates the JWT, then runs the bot. When
// the bot is not configured yet, it reports so rather than erroring.
export async function handleTeamsMessage(req, res) {
  if (!adapter) {
    res.status(503).json({ error: 'Teams bot is not configured on this service' });
    return;
  }
  await adapter.process(req, res, context => bot.run(context));
}
