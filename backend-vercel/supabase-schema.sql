-- ============================================================
-- 出貨資料比對系統 - 資料庫結構 v2（Supabase / PostgreSQL 版）
-- 從 Railway MySQL 版本轉換而來
-- 使用方式：在 Supabase 專案的 SQL Editor 貼上整份執行即可
-- （Supabase 已內建資料庫，不需要、也不能執行 CREATE DATABASE）
-- ============================================================

-- 若要重建，可先解除註解以下兩行（會刪除舊資料，請小心使用）
-- DROP TABLE IF EXISTS shipment_records;
-- DROP TABLE IF EXISTS shipment_files;

CREATE TABLE IF NOT EXISTS shipment_files (
  id                 VARCHAR(64)  NOT NULL PRIMARY KEY,
  source_file_name   VARCHAR(255) NOT NULL,          -- 原始 Excel 檔名
  sheet_name         VARCHAR(100) NOT NULL,          -- 分頁名稱（Report / MES ...）
  model              VARCHAR(255)     NULL,          -- 這批資料的主要機種（快速瀏覽用）
  row_count          INT          NOT NULL DEFAULT 0,
  uploaded_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  storage_path       TEXT             NULL           -- 對應到 Supabase Storage 裡原始 Excel 檔案的路徑
);

CREATE INDEX IF NOT EXISTS idx_source_file_name ON shipment_files (source_file_name);

CREATE TABLE IF NOT EXISTS shipment_records (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id                   VARCHAR(64)  NOT NULL REFERENCES shipment_files(id) ON DELETE CASCADE,
  row_index                 INT          NOT NULL,

  -- A ~ D
  po_no                     VARCHAR(100)     NULL,   -- A  PO No.
  reference_id              VARCHAR(100)     NULL,   -- B  Reference ID
  so_no_container_no        VARCHAR(100)     NULL,   -- C  SO No./Container No.
  vessel                    VARCHAR(100)     NULL,   -- D  Vessel

  -- E ~ H
  item_model                VARCHAR(255)     NULL,   -- E  Item Model
  brand                     VARCHAR(100)     NULL,   -- F  Brand
  pallet_no                 VARCHAR(100)     NULL,   -- G  Pallet No.
  color                     VARCHAR(100)     NULL,   -- H  Color

  -- I ~ L（唯一碼：imei1）
  imei1                     VARCHAR(64)      NULL,   -- I  IMEI1  ★唯一碼
  imei2                     VARCHAR(64)      NULL,   -- J  IMEI2
  carton                    VARCHAR(100)     NULL,   -- K  Carton
  sim                       VARCHAR(100)     NULL,   -- L  SIM

  -- M ~ P（唯一碼：serial_no, mac_id, battery_sn）
  serial_no                 VARCHAR(64)      NULL,   -- M  Serial No.  ★唯一碼
  mac_id                    VARCHAR(64)      NULL,   -- N  MAC ID      ★唯一碼
  bluetooth_id              VARCHAR(64)      NULL,   -- O  Bluetooth ID
  battery_sn                VARCHAR(64)      NULL,   -- P  Battery SN  ★唯一碼

  -- Q ~ U
  build_no                  VARCHAR(100)     NULL,   -- Q  Build No.
  sim_preinstalled          VARCHAR(10)      NULL,   -- R  SIM preinstalled
  apn_loaded                VARCHAR(10)      NULL,   -- S  APN Loaded
  enrolled                  VARCHAR(10)      NULL,   -- T  Enrolled
  remark                    VARCHAR(500)     NULL,   -- U  Remark

  -- V ~ Z
  accessories               VARCHAR(255)     NULL,   -- V  Accessories
  housing                   VARCHAR(100)     NULL,   -- W  Housing
  screen                    VARCHAR(100)     NULL,   -- X  Screen
  screen_supplier           VARCHAR(100)     NULL,   -- Y  Screen supplier
  memory_comments           VARCHAR(255)     NULL,   -- Z  Memory comments

  -- AA ~ AI
  vibrator_supplier         VARCHAR(100)     NULL,   -- AA Vibrator supplier
  light_proximity_sensor    VARCHAR(100)     NULL,   -- AB Light and proximity sensor
  by_factory                VARCHAR(100)     NULL,   -- AC By Factory
  assembly_line              VARCHAR(100)     NULL,   -- AD Assembly Line
  manufactured_date         VARCHAR(20)      NULL,   -- AE Manufactured Date
  eid                       VARCHAR(64)      NULL,   -- AF EID
  internal_version          VARCHAR(100)     NULL,   -- AG Internal Version
  oem_unlock_code           VARCHAR(100)     NULL,   -- AH Oem Unlock Code
  sku_item_no               VARCHAR(100)     NULL,   -- AI SKU - Item No.

  -- AJ ~ AN（唯一碼：pcba_sn, lcd_sn, iccid）
  pcba_sn                   VARCHAR(64)      NULL,   -- AJ PCBA SN       ★唯一碼
  lcd_sn                    VARCHAR(64)      NULL,   -- AK LCD SN        ★唯一碼
  mambo_device_id           VARCHAR(100)     NULL,   -- AL Mambo Device ID
  bluetooth_mac_2           VARCHAR(64)      NULL,   -- AM Bluetooth MAC 2
  iccid                     VARCHAR(64)      NULL,   -- AN ICCID         ★唯一碼

  -- AO ~ AY
  rfid_epc_memory_brand     VARCHAR(100)     NULL,   -- AO RFID EPC MEMORY BRAND
  rfid_android_sn           VARCHAR(100)     NULL,   -- AP RFID (Android SN)
  battery_manufacture_date  VARCHAR(20)      NULL,   -- AQ Battery Manufacture Date
  isim                      VARCHAR(64)      NULL,   -- AR ISIM
  camera_indicator          VARCHAR(100)     NULL,   -- AS Camera Indicator
  wifi_5g                   VARCHAR(10)      NULL,   -- AT 5G Wifi
  guest_wifi                VARCHAR(10)      NULL,   -- AU Guest Wifi
  bt_mac_main_board         VARCHAR(64)      NULL,   -- AV BT MAC – Main Board
  bt_mac_daughter_board     VARCHAR(64)      NULL,   -- AW BT MAC – Daughter Board
  rfid_brand                VARCHAR(100)     NULL,   -- AX RFID Brand
  rfid_tid                  VARCHAR(100)     NULL,   -- AY RFID TID

  -- AZ ~ BE（唯一碼：pcb_main_board_sn, sim_unlock_code）
  pcb_main_board_sn         VARCHAR(64)      NULL,   -- AZ PCB Main Board Serial No. ★唯一碼
  ble_pcb_serial_no         VARCHAR(64)      NULL,   -- BA BLE PCB Serial No.
  unit_remarks              VARCHAR(255)     NULL,   -- BB Unit Remarks
  esim_iccid                VARCHAR(64)      NULL,   -- BC eSIM ICCID
  imsi                      VARCHAR(64)      NULL,   -- BD IMSI
  sim_unlock_code           VARCHAR(100)     NULL,   -- BE SIM Unlock Code           ★唯一碼

  -- 保留整列原始資料作為備援（避免版型微調時漏欄位）
  -- 目前前端會存成 CSV 格式的一行文字（JSONB 也能存字串，讀出來會多一層 JSON 字串的雙引號）
  full_row                  JSONB        NOT NULL
);

-- 只針對 9 個唯一碼欄位建索引（查重複用），其餘欄位不建索引避免拖慢寫入
CREATE INDEX IF NOT EXISTS idx_imei1               ON shipment_records (imei1);
CREATE INDEX IF NOT EXISTS idx_serial_no            ON shipment_records (serial_no);
CREATE INDEX IF NOT EXISTS idx_mac_id               ON shipment_records (mac_id);
CREATE INDEX IF NOT EXISTS idx_battery_sn           ON shipment_records (battery_sn);
CREATE INDEX IF NOT EXISTS idx_pcba_sn              ON shipment_records (pcba_sn);
CREATE INDEX IF NOT EXISTS idx_lcd_sn               ON shipment_records (lcd_sn);
CREATE INDEX IF NOT EXISTS idx_iccid                ON shipment_records (iccid);
CREATE INDEX IF NOT EXISTS idx_pcb_main_board_sn    ON shipment_records (pcb_main_board_sn);
CREATE INDEX IF NOT EXISTS idx_sim_unlock_code      ON shipment_records (sim_unlock_code);
CREATE INDEX IF NOT EXISTS idx_file_id              ON shipment_records (file_id);
CREATE INDEX IF NOT EXISTS idx_item_model           ON shipment_records (item_model);
CREATE INDEX IF NOT EXISTS idx_po_no                ON shipment_records (po_no);

-- ============================================================
-- Row Level Security（Supabase 預設建議開啟 RLS）
-- 若你是透過 service_role key（後端）存取，可先開啟但不加 policy，
-- 這樣一般 anon/authenticated 角色會被擋掉，只有 service_role 能讀寫。
-- 若前端要直接用 anon/authenticated key 存取，需自行加上對應的 policy。
-- ============================================================
ALTER TABLE shipment_files   ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_records ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 【新增】前端目前是直接用 anon key 存取（沒有另外的後端伺服器），
-- 所以要補上讓 anon 角色可以完全讀寫的 policy，不然所有寫入都會被 RLS 擋掉
-- ============================================================
DROP POLICY IF EXISTS "Allow anon full access" ON shipment_files;
CREATE POLICY "Allow anon full access" ON shipment_files
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access" ON shipment_records;
CREATE POLICY "Allow anon full access" ON shipment_records
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- 確認政策已經建立（應該要看到兩筆，roles 欄位顯示 {anon}）
SELECT tablename, policyname, roles
FROM pg_policies
WHERE tablename IN ('shipment_files', 'shipment_records');
