-- The part-number configurator logs a row when a build ends, so there is a
-- record of what the engine produced before the September review. A build ends
-- either by completing, when a code is assembled, or by an explicit cancel. A
-- build dropped by closing the tab is not observable here: there is no session
-- store and no user identity, so completed = false means an explicit cancel, not
-- silent drop-off. No user identity is logged. The model and the produced code
-- describe a valve, not a person.
CREATE TABLE IF NOT EXISTS configurator_builds (
  id          bigserial PRIMARY KEY,
  model       text NOT NULL,            -- the config id, e.g. MK601
  completed   boolean NOT NULL,         -- true when a part number was assembled
  slot_count  int NOT NULL,             -- required slots filled when the build ended
  code        text,                     -- the assembled part number, null when cancelled
  latency_ms  int,                      -- the terminal turn's latency
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS configurator_builds_created_idx ON configurator_builds (created_at);
CREATE INDEX IF NOT EXISTS configurator_builds_model_idx ON configurator_builds (model);
