-- Additive migration for the mt#2666 ask-router audit event type
-- `ask.policy_closed`: emitted by the asks.create command layer when the
-- policy-first router closes an Ask at creation (phase-1 coverage), making
-- the closure class reviewable via events_list. ALTER TYPE ADD VALUE only —
-- mirrors 0042/0045/0049/0051.
ALTER TYPE "public"."system_event_type" ADD VALUE 'ask.policy_closed';
