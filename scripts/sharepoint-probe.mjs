#!/usr/bin/env node
// Prove or disprove the engine's SharePoint read access, from a machine with
// .env. Read-only throughout: it lists names and sizes and, with --get,
// downloads one file and reports its byte count without printing a word of
// its contents.
//
//   node --env-file=.env scripts/sharepoint-probe.mjs                    site + top-level folders
//   node --env-file=.env scripts/sharepoint-probe.mjs --path "Richards"  list a folder
//   node --env-file=.env scripts/sharepoint-probe.mjs --get "Richards/somefile.pdf"
import { spSite, resolveSite, listFolder, downloadFile } from '../src/sharepoint.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const PATH = flag('--path') || '';
const GET = flag('--get');

const grantHelp = () => {
  console.log(`
No read access yet. Two short steps for James, on the same app registration
as the mail permission (client id starting ${String(process.env.MS_CLIENT_ID || '').slice(0, 8) || 'unknown'}):

1. Entra admin centre > App registrations > the engine app > API permissions
   > Add a permission > Microsoft Graph > Application permissions >
   Sites.Selected > Add, then Grant admin consent. This alone grants access
   to nothing; it only allows step 2.

2. Grant the app read on the Sales Engine site only. Easiest in Graph
   Explorer (signed in as admin, with Sites.FullControl.All consented to
   Graph Explorer itself for this one call):
     POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
     { "roles": ["read"],
       "grantedToIdentities": [{ "application": {
         "id": "<the engine app's client id>", "displayName": "PCT Engine" } }] }
   The siteId comes from GET /v1.0/sites/${spSite()} in the same tool.

Then re-run this probe. If the tenant already carries a broader Files or
Sites read permission for the app, the probe simply works and nothing more
is needed.`);
};

try {
  const site = await resolveSite();
  console.log(`Site resolved: ${site.displayName || site.name} (${site.webUrl})`);
} catch (e) {
  console.error(`Could not resolve the site ${spSite()}: ${String(e.message).slice(0, 200)}`);
  if (e.status === 401 || e.status === 403) grantHelp();
  else console.log('Check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in .env, and the site name.');
  process.exit(1);
}

try {
  if (GET) {
    const buf = await downloadFile(GET);
    console.log(`Downloaded ${GET}: ${buf.length.toLocaleString('en-GB')} bytes. Contents not printed.`);
  } else {
    const items = await listFolder(PATH);
    console.log(`${PATH || 'Document library root'}: ${items.length} item(s)`);
    for (const i of items) {
      console.log(`  ${i.folder ? 'folder' : 'file  '}  ${i.name}${i.folder ? `  (${i.children} item${i.children === 1 ? '' : 's'})` : `  (${(i.size ?? 0).toLocaleString('en-GB')} bytes)`}`);
    }
    console.log('\nRead access works. Ingests can now take sharepoint:<path> sources.');
  }
} catch (e) {
  console.error(`Listed the site but could not read the library: ${String(e.message).slice(0, 200)}`);
  if (e.status === 401 || e.status === 403) grantHelp();
  process.exit(1);
}
