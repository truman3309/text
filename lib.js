import { createClient } from '@supabase/supabase-js';

// 不同的 Supabase／Vercel 整合方式,自動產生的環境變數名稱不完全一樣，
// 這裡依序嘗試幾種常見命名，只要其中一組存在就能用，不用每次手動對名字
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SECRET_KEY;

// 用 service_role 金鑰（不是 anon key）連線，這個金鑰只能放在後端環境變數，
// 絕對不能寫進前端程式碼或洩漏出去——它可以繞過 RLS，等於資料庫的完整權限。
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export function setCors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 每個 API handler 開頭都呼叫這個，處理瀏覽器送出的 CORS 預檢請求
export function handlePreflight(req, res){
  setCors(res);
  if(req.method === 'OPTIONS'){
    res.status(204).end();
    return true;
  }
  return false;
}

// Excel 全部 57 欄（A~BE）的對應表：前端送來的駝峰命名 -> 資料庫欄位名（snake_case）
export const FIELD_MAP = [
  ['poNo', 'po_no'], ['referenceId', 'reference_id'], ['soNoContainerNo', 'so_no_container_no'], ['vessel', 'vessel'],
  ['itemModel', 'item_model'], ['brand', 'brand'], ['palletNo', 'pallet_no'], ['color', 'color'],
  ['imei1', 'imei1'], ['imei2', 'imei2'], ['carton', 'carton'], ['sim', 'sim'],
  ['serialNo', 'serial_no'], ['macId', 'mac_id'], ['bluetoothId', 'bluetooth_id'], ['batterySn', 'battery_sn'],
  ['buildNo', 'build_no'], ['simPreinstalled', 'sim_preinstalled'], ['apnLoaded', 'apn_loaded'], ['enrolled', 'enrolled'], ['remark', 'remark'],
  ['accessories', 'accessories'], ['housing', 'housing'], ['screen', 'screen'], ['screenSupplier', 'screen_supplier'], ['memoryComments', 'memory_comments'],
  ['vibratorSupplier', 'vibrator_supplier'], ['lightProximitySensor', 'light_proximity_sensor'], ['byFactory', 'by_factory'], ['assemblyLine', 'assembly_line'],
  ['manufacturedDate', 'manufactured_date'], ['eid', 'eid'], ['internalVersion', 'internal_version'], ['oemUnlockCode', 'oem_unlock_code'], ['skuItemNo', 'sku_item_no'],
  ['pcbaSn', 'pcba_sn'], ['lcdSn', 'lcd_sn'], ['mamboDeviceId', 'mambo_device_id'], ['bluetoothMac2', 'bluetooth_mac_2'], ['iccid', 'iccid'],
  ['rfidEpcMemoryBrand', 'rfid_epc_memory_brand'], ['rfidAndroidSn', 'rfid_android_sn'], ['batteryManufactureDate', 'battery_manufacture_date'], ['isim', 'isim'],
  ['cameraIndicator', 'camera_indicator'], ['wifi5g', 'wifi_5g'], ['guestWifi', 'guest_wifi'], ['btMacMainBoard', 'bt_mac_main_board'], ['btMacDaughterBoard', 'bt_mac_daughter_board'],
  ['rfidBrand', 'rfid_brand'], ['rfidTid', 'rfid_tid'], ['pcbMainBoardSn', 'pcb_main_board_sn'], ['blePcbSerialNo', 'ble_pcb_serial_no'], ['unitRemarks', 'unit_remarks'],
  ['esimIccid', 'esim_iccid'], ['imsi', 'imsi'], ['simUnlockCode', 'sim_unlock_code'],
];

export function genId(){
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
