-- ============================================================
-- 關閉「匿名直接連資料庫」（配合伺服器轉送 /api/db 使用）
-- 在 Supabase 後台 → SQL Editor 整份貼上執行。
--
-- 為什麼一定要執行：
--   網頁改成經過 /api/db 之後，瀏覽器已經拿不到金鑰了。
--   但舊的 anon key 之前已經公開過，如果資料庫還允許 anon 讀寫，
--   拿到舊 key 的人一樣能繞過你的伺服器直接連資料庫。
--
-- 這份 SQL 不需要登入、不需要白名單，只是把 anon 和 authenticated 的權限收回。
-- （Supabase 預設開放任何人自行註冊帳號，註冊後的角色就是 authenticated，網頁完全用不到這個角色）
-- /api/db 用的是 service_role 金鑰（只在 Vercel 環境變數裡），不受影響。
-- ============================================================

BEGIN;

-- 1. 拿掉 anon 全開的政策
DROP POLICY IF EXISTS "Allow anon full access" ON shipment_files;
DROP POLICY IF EXISTS "Allow anon full access" ON shipment_records;

-- 2. 收回 anon 對資料表的所有權限（RLS 保持開啟）
ALTER TABLE shipment_files   ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON shipment_files, shipment_records FROM anon, authenticated;

-- 3. View 和函式也不讓 anon 用
DO $$
DECLARE fn record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='model_shipment_counts') THEN
    EXECUTE 'REVOKE ALL ON public.model_shipment_counts FROM anon, authenticated';
  END IF;
  FOR fn IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('find_duplicate_records', 'shipment_stats_by_model')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
  END LOOP;
END $$;

-- 4. 原始 Excel 的存放區改成不公開
UPDATE storage.buckets SET public = false WHERE id = 'excel-files';

COMMIT;

-- ============================================================
-- ★ 手動檢查 Storage 的舊政策
-- 下面會列出 storage.objects 上的所有政策。
-- 只要 roles 欄位是 {anon}、{authenticated} 或 {public}、而且跟 excel-files 有關的，都要手動刪掉：
--   DROP POLICY "政策名稱" ON storage.objects;
-- ============================================================
SELECT policyname, roles, cmd FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

-- 確認資料表已經沒有 anon 的政策（應該是 0 筆）
SELECT tablename, policyname, roles FROM pg_policies
WHERE tablename IN ('shipment_files', 'shipment_records') AND roles && ARRAY['anon','authenticated']::name[];
