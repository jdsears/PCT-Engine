-- The LinkedIn stage in the outreach sequence, John's design of 24 August
-- 2026: emails one and two as they are, then a direct message from James or
-- Andy on their own profile, then, if still nothing, a carefully worded
-- break-up email from the regional rep. Two things the engine could not do
-- before: know whether an invitation was accepted (a DM only reaches a
-- first-degree connection, so without this the stage could never be honest),
-- and hold the break-up until the LinkedIn stage has had its turn.

-- Connection state, learned by reading our own invitee's profile through the
-- inviting account. checked_at exists so the sweep can knock politely and
-- give up: an invitation nobody accepts is not an error, it is an answer.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_connected_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS li_connection_checked_at timestamptz;

-- The messages themselves, kept like posts rather than like emails: drafted
-- by the engine, sanctioned by a person (per message, or by the standing
-- automatic sanction), released by the drip inside the same per-account pace
-- and caps as invites, because LinkedIn counts every action against the same
-- profile. One open message per contact; a sent one is history.
CREATE TABLE IF NOT EXISTS li_messages (
  id           bigserial PRIMARY KEY,
  contact_id   bigint NOT NULL REFERENCES contacts(id),
  company_id   bigint REFERENCES companies(id),
  lead_id      bigint REFERENCES leads(id),
  campaign     text NOT NULL,
  body         text NOT NULL,
  grounding    jsonb,
  flags        jsonb,                              -- blocking flags, same vocabulary as a draft
  status       text NOT NULL DEFAULT 'draft',      -- draft | approved | sent | rejected
  approved_at  timestamptz,
  approved_by  text,
  sent_at      timestamptz,
  sent_by      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS li_messages_open_idx
  ON li_messages (contact_id) WHERE status IN ('draft', 'approved');
CREATE INDEX IF NOT EXISTS li_messages_queue_idx ON li_messages (campaign, status);
