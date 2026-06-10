// The LinkedIn research lane, Sales Navigator via Unipile. James is setting the
// accounts up, so this is the socket the lane will fill: same name, same
// signature, same return shape. The orchestrator calls it and carries on when
// it reports unavailable. No Unipile code yet.

export async function findContacts(company, roles = []) {
  console.log(`  LinkedIn lane not yet connected, skipping contact discovery for ${company.name} (${roles.length} role filters)`);
  return { available: false, contacts: [] };
}
