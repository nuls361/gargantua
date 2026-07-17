-- =============================================================
-- Reworked importer: a CSV is imported into a list, and the whole batch
-- carries three shared properties for later orientation — a label, a region,
-- and a "sample creator" (a reference creator the list is modelled on).
-- Every lead in the import gets these stamped on.
-- =============================================================

-- Sample/reference creator, stamped on every lead of an import batch.
alter table creators add column if not exists sample_creator text;

-- Richer import history: remember the batch label, sample creator and target list.
alter table imports add column if not exists label text;
alter table imports add column if not exists sample_creator text;
alter table imports add column if not exists list_id uuid references lists(id);
