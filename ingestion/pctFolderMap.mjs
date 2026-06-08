import { EXCLUDED_FOLDERS } from './folderMap.mjs';

// The PCT Information corpus holds material about PCT the company rather than
// product datasheets. We do not yet know the internal folder structure, so
// every included file is treated as company material. The walker still records
// the top-level folder name in metadata, so the structure is kept and can be
// used to enrich this mapping later.
//
// Protected folders are shared with the Richards map: customer lists, the
// example customer communications, and the January 2026 meeting notes stay out
// of retrieval regardless of which corpus they sit under.
export { EXCLUDED_FOLDERS };

export function mapFolder(_topFolder) {
  return {
    include: true,
    segment: 'company',
    line: null,
    campaignLine: false,
    manufacturer: null,
    application: null,
    nameable: true,
    docType: null,
  };
}

// Files to skip even though their folder is included. The sales-areas postcode
// map is held as a structured region lookup for the Regional Agents, not
// embedded, so its label text would only be noise in the index.
export function excludeFile(title) {
  return /sales areas/i.test(title || '');
}
