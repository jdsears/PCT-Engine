-- The supplier's partner price beside its list price, 11 September 2026.
-- James's rule for Alicat: cost is list less 35%, except BASIS MEMS thermal
-- and EPC units, where cost is the partner price the list prints; standard
-- accuracy CODA, where the partner price is 20% off; and recalibrations and
-- cleaning, where cost is the stated price with no discount. The partner
-- price is kept as read so the answer can say which figure the cost is.
ALTER TABLE supplier_prices ADD COLUMN IF NOT EXISTS partner_price numeric;
ALTER TABLE supplier_prices ADD COLUMN IF NOT EXISTS cost_rule text;
