-- An option can be a credit, 11 September 2026: the customer list prices
-- "None (O)" on the display choice at minus £83, and a credit is as much
-- an adder as a charge. The check that kept adders non-negative comes off.
ALTER TABLE price_options DROP CONSTRAINT IF EXISTS price_options_adder_check;
