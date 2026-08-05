// The SQL for recording a review decision, built to survive a schema that has
// not caught up yet.
//
// decision_note is audit metadata: it says why a confirm chose no Companies
// House entity, so a later reader knows it was declined rather than
// overlooked. Useful, and never worth failing a human action for. The service
// deploys from main automatically while migrations are applied by hand, so
// there is a window in which the column does not exist, and a confirm that
// hard-fails in that window leaves the reviewer stuck on a working system.
//
// So the statement is built from what the schema actually has. Pure, so the
// gate can prove both shapes without a database.

export function decisionUpdate({ status, withNote, withActor, setCompany = true }) {
  const sets = [`status = '${status}'`];
  const params = [];
  if (setCompany) { params.push('company'); sets.push(`company_id = $${params.length}`); }
  if (withNote) { params.push('note'); sets.push(`decision_note = $${params.length}`); }
  // Who decided, when the schema has learned to hold it (migration 027). The
  // same survival rule as the note: an audit column is never worth failing a
  // human action for.
  if (withActor) { params.push('actor'); sets.push(`decided_by = $${params.length}`); }
  sets.push('decided_at = now()');
  params.push('id');
  return {
    sql: `UPDATE party_reviews SET ${sets.join(', ')} WHERE id = $${params.length}`,
    // The caller passes values in this order; 'note' and 'actor' are absent
    // when their columns are, so no value is bound for a column that cannot
    // be written.
    order: params,
  };
}

// Bind the values for the statement above, in the order it declared.
export function decisionValues(order, { company, note, actor, id }) {
  return order.map(k => (k === 'company' ? company : k === 'note' ? note : k === 'actor' ? actor : id));
}
