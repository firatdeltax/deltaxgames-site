-- DeltaX Financial Tracker — D1 şeması.
-- Cloudflare panelinde D1 > deltax-finance > Console'a yapıştırıp çalıştır.
-- Her kayıt bir JSON belgesi; koleksiyonlar: transactions, accounts, categories, rates, settings.

CREATE TABLE IF NOT EXISTS docs (
  collection TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL,            -- JSON gövde
  version    INTEGER NOT NULL DEFAULT 1,  -- her yazımda +1, çakışma kontrolü için
  updated_at TEXT    NOT NULL,            -- ISO 8601
  updated_by TEXT    NOT NULL,            -- yazan kişinin e-postası ya da "cron"
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS docs_collection ON docs (collection);
