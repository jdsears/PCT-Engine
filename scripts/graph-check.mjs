import { graphToken, graphJson } from '../src/msgraph.mjs';

const HOSTNAME = process.env.SP_HOSTNAME, SITE_PATH = process.env.SP_SITE_PATH;
let failed = false;
const pass = (m) => console.log('PASS ', m);
const fail = (m) => { failed = true; console.log('FAIL ', m); };

// 1. Token. Do not probe /sites/root here: with Sites.Selected the app only
// sees sites it has been granted, so the tenant root correctly returns 403.
try { await graphToken(); pass('token acquired'); }
catch (e) {
  if (String(e).includes('AADSTS7000215')) fail('invalid client secret, check MS_CLIENT_SECRET');
  else if (String(e).includes('AADSTS700016')) fail('app not found in tenant, check MS_CLIENT_ID and MS_TENANT_ID');
  else fail(`token request failed: ${e.message}`);
}

// 2. Site resolution and read, the step that fails if the per-site grant is missing
let siteId = null;
try {
  const site = await graphJson(`/sites/${HOSTNAME}:${SITE_PATH}`);
  siteId = site.id;
  pass(`site resolved: ${site.displayName} (${siteId})`);
} catch (e) {
  if (e.status === 403 || e.status === 401) {
    fail('site read denied. The per-site grant is missing. Ask PCT to run:');
    console.log(`  Grant-PnPAzureADAppSitePermission -AppId ${process.env.MS_CLIENT_ID} -DisplayName "MoonBoots PCT Co-Pilot" -Site "https://${HOSTNAME}${SITE_PATH}" -Permissions Read`);
  } else fail(`site resolution failed: ${e.message}`);
}

// 3. List the document library, two levels deep, so the folder names can be
// compared with the local snapshot before any ingestion runs.
if (siteId) {
  try {
    const drive = await graphJson(`/sites/${siteId}/drive`);
    const items = await graphJson(`/sites/${siteId}/drives/${drive.id}/root/children`);
    pass(`default library "${drive.name}" readable, ${items.value.length} top-level items:`);
    for (const it of items.value) {
      console.log(`   ${it.folder ? '[dir] ' : '[file]'} ${it.name}`);
      if (it.folder) {
        const kids = await graphJson(`/sites/${siteId}/drives/${drive.id}/items/${it.id}/children?$top=200`);
        for (const k of kids.value) console.log(`      ${k.folder ? '[dir] ' : '[file]'} ${k.name}`);
      }
    }
  } catch (e) { fail(`library listing failed: ${e.message}`); }
}

// 4. Mail surface: report only, never send
console.log(failed ? '\nResolve the failures above, then re-run.' : '\nAll Graph read checks passed.');
console.log(`Mail kill switch: ${process.env.MAIL_KILL_SWITCH || 'on'} (no send is attempted by this check).`);
process.exit(failed ? 1 : 0);
