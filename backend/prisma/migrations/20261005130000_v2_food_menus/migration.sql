-- V2 food menus: a restaurant's / cafe's MENU is its own two-level category
-- tree — top category = MENU, subcategory = MENU SECTION, product = FOOD ITEM
-- (the same tree every other seller uses for Category → Subcategory). Before
-- this, food sellers had one flat level of menu sections (top categories).
--
-- Data only, additive: for each food seller that still has flat sections, add
-- one "Main Menu" top category and move its live top-level sections under it.
-- Nothing is deleted; products keep their category ids.

DO $$
DECLARE
  s RECORD;
  menu_id uuid;
  menu_slug text;
BEGIN
  FOR s IN
    SELECT DISTINCT c.seller_id
    FROM categories c
    JOIN sellers se ON se.id = c.seller_id
    WHERE se.seller_type::text IN ('RESTAURANT', 'CAFE')
      AND c.parent_id IS NULL
      AND c.deleted_at IS NULL
  LOOP
    menu_slug := 'main-menu';
    IF EXISTS (
      SELECT 1 FROM categories
      WHERE seller_id = s.seller_id AND parent_id IS NULL AND slug = menu_slug AND deleted_at IS NULL
    ) THEN
      menu_slug := 'main-menu-' || substr(md5(random()::text), 1, 6);
    END IF;

    menu_id := gen_random_uuid();
    INSERT INTO categories (id, seller_id, parent_id, name, slug, path, depth, display_order, is_active, vertical, created_at, updated_at)
    VALUES (menu_id, s.seller_id, NULL, 'Main Menu', menu_slug, menu_slug, 0, 0, true, 'FOOD', now(), now());

    UPDATE categories
    SET parent_id = menu_id,
        depth = 1,
        path = menu_slug || '/' || slug,
        updated_at = now()
    WHERE seller_id = s.seller_id
      AND parent_id IS NULL
      AND deleted_at IS NULL
      AND id <> menu_id;
  END LOOP;
END $$;
