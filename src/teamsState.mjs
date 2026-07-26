// Short-term, in-memory conversation state for the Teams co-pilot. Holding it
// here, keyed on the Teams conversation id, is what lets a Teams chat carry a
// thread and a part-number build across turns, exactly as the web chat does.
//
// The privacy decision holds: nothing is persisted. The conversation id is used
// only as an in-memory routing key and is never written to the database or the
// logs; state evaporates on restart and after the TTL. Attribution remains a
// future decision to take with PCT.
export function createConversationStore({ ttlMs = 30 * 60_000, maxConversations = 500, maxTurns = 12, now = Date.now } = {}) {
  const conversations = new Map(); // id -> { history, configState, quoteState, last }

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [id, c] of conversations) if (c.last < cutoff) conversations.delete(id);
  }
  // Map iteration is insertion order and remember() reinserts on update, so the
  // oldest-touched conversation is evicted first. Runs after an insert, so the
  // store never exceeds the cap even by one.
  function enforceCap() {
    while (conversations.size > maxConversations) conversations.delete(conversations.keys().next().value);
  }

  return {
    // The state to hand to ask(): recent turns and any build in progress.
    get(id) {
      sweep();
      if (!id) return { history: [], configState: null, quoteState: null };
      const c = conversations.get(id);
      if (!c || c.last < now() - ttlMs) return { history: [], configState: null, quoteState: null };
      return { history: [...c.history], configState: c.configState, quoteState: c.quoteState ?? null };
    },
    // Record a completed turn. The build state is replaced, never merged, since
    // ask() returns the full next state or null when a build ends.
    remember(id, userText, result) {
      if (!id) return;
      sweep();
      const c = conversations.get(id) || { history: [], configState: null, quoteState: null, last: 0 };
      c.history = [...c.history, { role: 'user', text: userText }, { role: 'copilot', text: result.answer }].slice(-maxTurns);
      c.configState = result.configState ?? null;
      c.quoteState = result.quoteState ?? null;
      c.last = now();
      conversations.delete(id);
      conversations.set(id, c);
      enforceCap();
    },
    size() { return conversations.size; },
  };
}
