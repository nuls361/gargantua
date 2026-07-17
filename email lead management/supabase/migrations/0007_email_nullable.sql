-- Sourced creators have no email until enrichment, so email must be nullable.
-- (email_normalized is generated from email and already allows NULLs; the UNIQUE
-- constraint permits multiple NULLs, so many un-enriched creators can coexist.)
alter table creators alter column email drop not null;
