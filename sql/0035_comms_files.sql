-- 0035 Pictures in bulk emails: files area "comms" (Communication › Messages). No new table – the area list grows.
ALTER TABLE app.files DROP CONSTRAINT IF EXISTS files_area_check;
ALTER TABLE app.files ADD CONSTRAINT files_area_check CHECK (area IN ('id-check', 'record', 'minutes', 'event', 'brand', 'website', 'zakat', 'finance', 'ticket', 'other', 'comms'));
