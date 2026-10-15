-- ============================================================
-- 請求頻率限制（給 /api/db、/api/storage 使用）
-- 在 Supabase SQL Editor 整份執行。可以重複執行。
--
-- 原理：伺服器每收到一個請求，就呼叫 api_rate_hit() 幫「這個 IP + 這類操作」計數，
--       超過上限就拒絕。計數存在資料庫，所以 Vercel 開幾台伺服器都會共用同一份計數。
-- 只有伺服器（service_role）能呼叫，網頁和匿名使用者都碰不到。
-- ============================================================

CREATE TABLE IF NOT EXISTS api_rate_limits (
  key           TEXT        NOT NULL,   -- 例如 "ip:1.2.3.4:delete"、"global:delete"
  window_start  TIMESTAMPTZ NOT NULL,   -- 這個計數區間的開始時間
  count         INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON api_rate_limits FROM anon, authenticated;

-- 計數一次，回傳「是否還在上限內」
CREATE OR REPLACE FUNCTION public.api_rate_hit(p_key TEXT, p_window_seconds INT, p_limit INT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w TIMESTAMPTZ := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  c INT;
BEGIN
  INSERT INTO api_rate_limits (key, window_start, count) VALUES (p_key, w, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = api_rate_limits.count + 1
  RETURNING count INTO c;
  -- 偶爾順手清掉一天以前的舊計數，避免資料表一直變大
  IF random() < 0.01 THEN
    DELETE FROM api_rate_limits WHERE window_start < now() - INTERVAL '1 day';
  END IF;
  RETURN c <= p_limit;
END $$;

REVOKE ALL ON FUNCTION public.api_rate_hit(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_rate_hit(TEXT, INT, INT) TO service_role;
