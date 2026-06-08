export const PRODUCT_LINES = {
  '1. Jordan Valve':                { line: 'jordan',          campaignLine: true,  manufacturer: 'Richards Industrials' },
  '2. Steriflow':                   { line: 'steriflow',       campaignLine: true,  manufacturer: 'Richards Industrials' },
  '3. Steriflow Food and Beverage': { line: 'steriflow_fb',    campaignLine: true,  manufacturer: 'Richards Industrials' },
  '4. Low Flow':                    { line: 'low_flow',        campaignLine: false, manufacturer: 'Richards Industrials' },
  '5. Hexvalve':                    { line: 'hexvalve',        campaignLine: false, manufacturer: 'Richards Industrials' },
  '6. Bestobell Steam':             { line: 'bestobell_steam', campaignLine: false, manufacturer: 'Richards Industrials' },
  '7. Marwin':                      { line: 'marwin',          campaignLine: true,  manufacturer: 'Richards Industrials' },
  '8. Equilibar':                   { line: 'equilibar',       campaignLine: false, manufacturer: 'Equilibar' },
};

export const EXCLUDED_FOLDERS = new Set([
  'Customer Lists',         // protected account data, not retrieval
  'Example customer comms', // voice-training set, later phase
  'Meeting Jan 2026',       // internal notes, excluded for now
]);

export function mapFolder(topFolder) {
  if (PRODUCT_LINES[topFolder]) {
    const { line, campaignLine, manufacturer } = PRODUCT_LINES[topFolder];
    return { include: true, segment: 'product', line, campaignLine, manufacturer, application: null, nameable: true, docType: null };
  }
  if (topFolder === 'Data Centres') {
    return { include: true, segment: 'product', line: null, campaignLine: true, manufacturer: 'Richards Industrials', application: 'data_centre', nameable: true, docType: null };
  }
  if (topFolder === '(root)') {
    return { include: true, segment: 'product', line: null, campaignLine: false, manufacturer: 'Richards Industrials', application: null, nameable: true, docType: 'overview' };
  }
  return { include: false };
}
