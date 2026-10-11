-- A small copy of each photo for lists (about 640 px, 20 to 60 KB), made in the browser: the Worker has no CPU to
-- resize images on the free plan. NULL means no small copy yet, and lists use the full photo.
ALTER TABLE popup_images ADD COLUMN thumb_key TEXT;
-- "Which photos still need one?" reads only those rows, not the whole table.
CREATE INDEX IF NOT EXISTS idx_images_nothumb ON popup_images(id) WHERE thumb_key IS NULL;
