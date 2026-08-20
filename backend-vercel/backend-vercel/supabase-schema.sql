-- ============================================================
-- 出貨資料比對系統 - Supabase (Postgres) 資料庫結構
-- 到 Supabase 專案的 SQL Editor，貼上整份執行
-- ============================================================

CREATE TABLE IF NOT EXISTS shipment_files (
  id                 TEXT         PRIMARY KEY,
  source_file_name   TEXT         NOT NULL,
  sheet_name         TEXT         NOT NULL,
  model              TEXT,
  row_count          INTEGER      NOT NULL DEFAULT 0,
  uploaded_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_file_name ON shipment_files(source_file_name);

CREATE TABLE IF NOT EXISTS shipment_records (
  id                        BIGSERIAL   PRIMARY KEY,
  file_id                   TEXT        NOT NULL REFERENCES shipment_files(id) ON DELETE CASCADE,
  row_index                 INTEGER     NOT NULL,

  po_no                     TEXT,
  reference_id              TEXT,
  so_no_container_no        TEXT,
  vessel                    TEXT,
  item_model                TEXT,
  brand                     TEXT,
  pallet_no                 TEXT,
  color                     TEXT,
  imei1                     TEXT,   -- ★唯一碼
  imei2                     TEXT,
  carton                    TEXT,
  sim                       TEXT,
  serial_no                 TEXT,   -- ★唯一碼
  mac_id                    TEXT,   -- ★唯一碼
  bluetooth_id              TEXT,
  battery_sn                TEXT,   -- ★唯一碼
  build_no                  TEXT,
  sim_preinstalled          TEXT,
  apn_loaded                TEXT,
  enrolled                  TEXT,
  remark                    TEXT,
  accessories                TEXT,
  housing                   TEXT,
  screen                    TEXT,
  screen_supplier           TEXT,
  memory_comments           TEXT,
  vibrator_supplier         TEXT,
  light_proximity_sensor    TEXT,
  by_factory                TEXT,
  assembly_line             TEXT,
  manufactured_date         TEXT,
  eid                       TEXT,
  internal_version          TEXT,
  oem_unlock_code           TEXT,
  sku_item_no               TEXT,
  pcba_sn                   TEXT,   -- ★唯一碼
  lcd_sn                    TEXT,   -- ★唯一碼
  mambo_device_id           TEXT,
  bluetooth_mac_2           TEXT,
  iccid                     TEXT,   -- ★唯一碼
  rfid_epc_memory_brand     TEXT,
  rfid_android_sn           TEXT,
  battery_manufacture_date  TEXT,
  isim                      TEXT,
  camera_indicator          TEXT,
  wifi_5g                   TEXT,
  guest_wifi                TEXT,
  bt_mac_main_board         TEXT,
  bt_mac_daughter_board     TEXT,
  rfid_brand                TEXT,
  rfid_tid                  TEXT,
  pcb_main_board_sn         TEXT,   -- ★唯一碼
  ble_pcb_serial_no         TEXT,
  unit_remarks               TEXT,
  esim_iccid                TEXT,
  imsi                      TEXT,
  sim_unlock_code           TEXT,   -- ★唯一碼

  full_row                  JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imei1 ON shipment_records(imei1);
CREATE INDEX IF NOT EXISTS idx_serial_no ON shipment_records(serial_no);
CREATE INDEX IF NOT EXISTS idx_mac_id ON shipment_records(mac_id);
CREATE INDEX IF NOT EXISTS idx_battery_sn ON shipment_records(battery_sn);
CREATE INDEX IF NOT EXISTS idx_pcba_sn ON shipment_records(pcba_sn);
CREATE INDEX IF NOT EXISTS idx_lcd_sn ON shipment_records(lcd_sn);
CREATE INDEX IF NOT EXISTS idx_iccid ON shipment_records(iccid);
CREATE INDEX IF NOT EXISTS idx_pcb_main_board_sn ON shipment_records(pcb_main_board_sn);
CREATE INDEX IF NOT EXISTS idx_sim_unlock_code ON shipment_records(sim_unlock_code);
CREATE INDEX IF NOT EXISTS idx_file_id ON shipment_records(file_id);
CREATE INDEX IF NOT EXISTS idx_item_model ON shipment_records(item_model);
CREATE INDEX IF NOT EXISTS idx_po_no ON shipment_records(po_no);

-- 後端用 service_role 金鑰連線，會自動繞過 RLS，這裡不需要另外寫政策。
-- 但保險起見，明確關閉 RLS，避免 Supabase 專案預設把它打開導致查詢被擋。
ALTER TABLE shipment_files DISABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_records DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 找重複用的資料庫函式（因為 Supabase 的 JS 客戶端沒辦法直接下
-- GROUP BY ... HAVING COUNT(*) > 1 這種語法，改用 Postgres 函式，
-- 前端／API 用 supabase.rpc('find_duplicate_records') 呼叫）
-- ============================================================
CREATE OR REPLACE FUNCTION find_duplicate_records()
RETURNS TABLE (
  field TEXT,
  matched_value TEXT,
  id BIGINT,
  file_id TEXT,
  row_index INTEGER,
  full_row JSONB,
  source_file_name TEXT,
  sheet_name TEXT,
  model TEXT,
  uploaded_at TIMESTAMPTZ
) AS $$
DECLARE
  fields TEXT[] := ARRAY['imei1','serial_no','mac_id','battery_sn','pcba_sn','lcd_sn','iccid','pcb_main_board_sn','sim_unlock_code'];
  f TEXT;
BEGIN
  FOREACH f IN ARRAY fields LOOP
    RETURN QUERY EXECUTE format($f$
      SELECT %L::TEXT AS field, sr.%I::TEXT AS matched_value, sr.id, sr.file_id, sr.row_index, sr.full_row,
             sf.source_file_name, sf.sheet_name, sf.model, sf.uploaded_at
      FROM shipment_records sr
      JOIN shipment_files sf ON sr.file_id = sf.id
      WHERE sr.%I IN (
        SELECT %I FROM shipment_records
        WHERE %I IS NOT NULL AND %I <> ''
        GROUP BY %I HAVING COUNT(*) > 1
      )
    $f$, f, f, f, f, f, f, f);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 依機種統計出貨量用的函式
-- ============================================================
CREATE OR REPLACE FUNCTION shipment_stats_by_model()
RETURNS TABLE(item_model TEXT, qty BIGINT) AS $$
  SELECT item_model, COUNT(*) AS qty
  FROM shipment_records
  WHERE item_model IS NOT NULL AND item_model <> ''
  GROUP BY item_model
  ORDER BY qty DESC;
$$ LANGUAGE sql STABLE;
