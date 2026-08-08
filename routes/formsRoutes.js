const express = require('express')
const axios = require('axios')
const http = require('http')
const https = require('https')

const router = express.Router()
const Branch = require('../models/branchModel')

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 100 })
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 100 })

const GOOGLE_FORM_DEFAULTS = {
  fvv: '1',
  draftResponse: '[]',
  pageHistory: '0',
}

function normalizeString(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  return String(value).trim()
}

function normalizeMobile10(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(-10)
  return d.length === 10 ? d : ''
}

function shortId6() {
  try {
    const { ulid } = require('ulid')
    const id = ulid() // Crockford base32, 26 chars
    return id.slice(-6)
  } catch (e) {
    const crypto = require('crypto')
    return crypto.randomBytes(4).toString('hex').slice(-6).toUpperCase()
  }
}

// Ultra-fast serial generator: uses timestamp for guaranteed uniqueness without DB scans.
function buildSerial(kind, branchCode) {
  const bc = String(branchCode || '').trim().toUpperCase()
  const prefix = kind === 'jobcard' ? 'JC' : 'Q'
  
  const now = new Date()
  const yy = String(now.getFullYear()).slice(-2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  
  // Format: JC-BRANCH-YYMMDD-HHMMSS
  return `${prefix}-${bc}-${yy}${mm}${dd}-${hh}${min}${ss}`
}

function ensureEntries(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {}
  }
  return obj
}

function buildFormUrl(formId) {
  return `https://docs.google.com/forms/d/e/${formId}/formResponse`
}

async function submitToGoogleForm(formId, entriesInput) {
  const entries = { ...GOOGLE_FORM_DEFAULTS, ...ensureEntries(entriesInput) }
  const params = new URLSearchParams()
  Object.entries(entries).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    params.append(key, value === '' ? '' : String(value))
  })

  await axios.post(buildFormUrl(formId), params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
}

// --- CSV helpers (no DB persistence) ---
const parseCsv = (text) => {
  const rows = []
  let row = [], col = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (c === '"' && !inQuotes) { inQuotes = true; continue }
    if (c === '"' && inQuotes) { if (n === '"') { col += '"'; i++; continue } inQuotes = false; continue }
    if (c === ',' && !inQuotes) { row.push(col); col = ''; continue }
    if ((c === '\n' || c === '\r') && !inQuotes) { if (col !== '' || row.length) { row.push(col); rows.push(row); row = []; col = '' } if (c === '\r' && n === '\n') i++; continue }
    col += c
  }
  if (col !== '' || row.length) { row.push(col); rows.push(row) }
  return rows
}

const findSerialIdx = (headers = [], kind = 'quotation') => {
  const rxQ = /^(quotation\s*no\.?|quotation\s*number|serial\s*no\.?|serial|quote\s*id)$/i
  const rxJ = /^(jc\s*no\.?|jc\s*number|job\s*card\s*no\.?|job\s*card\s*number|serial(?:\s*no\.?)?)$/i
  const rx = kind === 'jobcard' ? rxJ : rxQ
  let idx = headers.findIndex((h) => rx.test(String(h || '').trim()))
  if (idx >= 0) return idx
  idx = headers.findIndex((h) => /serial/i.test(String(h || '')))
  return idx >= 0 ? idx : -1
}

const parseIntStrict = (s) => {
  const t = String(s || '').trim()
  return /^\d+$/.test(t) ? parseInt(t, 10) : null
}

async function fetchCsv(url) {
  const res = await axios.get(url, { responseType: 'text', validateStatus: () => true })
  if (String(res.status).startsWith('2')) return res.data
  throw new Error(`CSV fetch failed with status ${res.status}`)
}

async function nextSerialFromCsv(url, kind = 'quotation') {
  const csv = await fetchCsv(url)
  const rows = parseCsv(csv)
  if (!rows.length) return '1'
  const header = rows[0] || []
  const idx = findSerialIdx(header, kind)
  if (idx < 0) return '1'
  for (let i = rows.length - 1; i >= 1; i--) {
    const n = parseIntStrict(rows[i][idx])
    if (n !== null && Number.isFinite(n)) return String(n + 1)
  }
  let max = 0
  for (let i = 1; i < rows.length; i++) {
    const n = parseIntStrict(rows[i][idx])
    if (n !== null && n > max) max = n
  }
  return String(max + 1 || 1)
}

async function serialExistsInCsv(url, serial, kind = 'quotation') {
  if (!serial) return false
  const csv = await fetchCsv(url)
  const rows = parseCsv(csv)
  if (!rows.length) return false
  const header = rows[0] || []
  const idx = findSerialIdx(header, kind)
  if (idx < 0) return false
  return rows.slice(1).some(r => String(r[idx]).trim() === String(serial).trim())
}

router.get('/quotation/next-serial', async (req, res) => {
  try {
    // Ultra-fast generation: no scan needed for timestamp-based IDs.
    const nextSerial = buildSerial('quotation', req.query.branchCode || 'GEN')
    return res.json({ success: true, nextSerial, source: 'instant' })
  } catch (error) {
    console.error('Failed to fetch next quotation serial:', error)
    return res.status(500).json({ success: false, message: 'Unable to fetch next serial number.' })
  }
})

// Reserve a server-issued quotation serial for a given mobile (idempotent per mobile)
router.post('/quotation/serial/reserve', async (req, res) => {
  try {
    const m10 = normalizeMobile10(req.body?.mobile)
    let bc = String(req.body?.branchCode || '').trim().toUpperCase()
    const branchId = req.body?.branchId
    if (!bc && branchId) {
      try {
        const br = await Branch.findById(branchId).lean()
        if (br?.code) bc = String(br.code).toUpperCase()
      } catch {}
    }
    if (!m10) return res.status(400).json({ success: false, message: 'Valid 10-digit mobile is required' })
    if (!bc) return res.status(400).json({ success: false, message: 'branchCode is required' })
    const serial = buildSerial('quotation', bc)
    return res.json({ success: true, serial })
  } catch (error) {
    console.error('Failed to reserve quotation serial:', error)
    return res.status(500).json({ success: false, message: 'Unable to reserve serial' })
  }
})

router.post('/quotation', async (req, res) => {
  try {
    const { formId, entries: rawEntries, payload, serialNo, serialEntryId, responsesCsvUrl } = req.body || {}
    if (!formId) {
      return res.status(400).json({ success: false, message: 'formId is required.' })
    }
    const entries = ensureEntries(rawEntries)
    let serial = normalizeString(serialNo)
    if (!serial && serialEntryId) serial = normalizeString(entries[serialEntryId])
    if (!serial) serial = normalizeString(entries.serial || entries.serialNo)
    if (!serial) {
      return res.status(400).json({ success: false, message: 'serialNo is required.' })
    }

    const csvUrl = responsesCsvUrl || process.env.QUOTATION_RESPONSES_CSV_URL
    if (csvUrl) {
      try {
        if (await serialExistsInCsv(csvUrl, serial, 'quotation')) {
          return res.json({ success: true, duplicate: true, message: 'Quotation already exists in sheet.' })
        }
      } catch (e) { /* continue if CSV not reachable */ }
    }

    await submitToGoogleForm(formId, entries)
    return res.json({ success: true, submittedToGoogle: true, message: 'Quotation saved to Google Sheet.' })
  } catch (error) {
    console.error('Failed to save quotation:', error.response?.data || error)
    return res.status(500).json({ success: false, message: 'Failed to save quotation.', detail: error.message })
  }
})

router.get('/jobcard/next-serial', async (req, res) => {
  try {
    const csvUrl = req.query.csv || process.env.JOBCARD_RESPONSES_CSV_URL || process.env.JOBCARD_SHEET_CSV_URL
    if (!csvUrl) return res.json({ success: true, nextSerial: '1', source: 'fallback' })
    const nextSerial = await nextSerialFromCsv(csvUrl, 'jobcard')
    return res.json({ success: true, nextSerial, source: 'csv' })
  } catch (error) {
    console.error('Failed to fetch next job card serial:', error)
    return res.status(500).json({ success: false, message: 'Unable to fetch next job card number.' })
  }
})

// Reserve a server-issued jobcard serial for a given mobile (idempotent per mobile)
router.post('/jobcard/serial/reserve', async (req, res) => {
  try {
    const m10 = normalizeMobile10(req.body?.mobile)
    let bc = String(req.body?.branchCode || '').trim().toUpperCase()
    const branchId = req.body?.branchId
    if (!bc && branchId) {
      try {
        const br = await Branch.findById(branchId).lean()
        if (br?.code) bc = String(br.code).toUpperCase()
      } catch {}
    }
    if (!m10) return res.status(400).json({ success: false, message: 'Valid 10-digit mobile is required' })
    if (!bc) return res.status(400).json({ success: false, message: 'branchCode is required' })
    // Ultra-fast generation: no collision check needed with second-level precision.
    const serial = buildSerial('jobcard', bc)
    return res.json({ success: true, serial })
  } catch (error) {
    console.error('Failed to reserve jobcard serial:', error)
    return res.status(500).json({ success: false, message: 'Unable to reserve serial' })
  }
})

router.post('/jobcard', async (req, res) => {
  try {
    const { formId, entries: rawEntries, metadata, jcNo, jcEntryId, responsesCsvUrl } = req.body || {}
    if (!formId) {
      return res.status(400).json({ success: false, message: 'formId is required.' })
    }
    const entries = ensureEntries(rawEntries)
    let jobCardNo = normalizeString(jcNo)
    if (!jobCardNo && jcEntryId) jobCardNo = normalizeString(entries[jcEntryId])
    if (!jobCardNo) jobCardNo = normalizeString(entries.jcNo)
    if (!jobCardNo) {
      return res.status(400).json({ success: false, message: 'jcNo is required.' })
    }

    const csvUrl = responsesCsvUrl || process.env.JOBCARD_RESPONSES_CSV_URL || process.env.JOBCARD_SHEET_CSV_URL
    if (csvUrl) {
      try {
        if (await serialExistsInCsv(csvUrl, jobCardNo, 'jobcard')) {
          return res.json({ success: true, duplicate: true, message: 'Job Card already exists in sheet.' })
        }
      } catch (e) { /* continue if CSV not reachable */ }
    }

    await submitToGoogleForm(formId, entries)
    return res.json({ success: true, submittedToGoogle: true, message: 'Job Card saved to Google Sheet.' })
  } catch (error) {
    console.error('Failed to save job card:', error.response?.data || error)
    return res.status(500).json({ success: false, message: 'Failed to save job card.', detail: error.message })
  }
})

// Booking: simple pass-through to Google Form. No serial checks.
router.post('/booking', async (req, res) => {
  try {
    const { formId, entries: rawEntries } = req.body || {}
    if (!formId) {
      return res.status(400).json({ success: false, message: 'formId is required.' })
    }
    const entries = ensureEntries(rawEntries)
    await submitToGoogleForm(formId, entries)
    return res.json({ success: true, submittedToGoogle: true, message: 'Booking saved to Google Sheet.' })
  } catch (error) {
    console.error('Failed to save booking:', error.response?.data || error)
    return res.status(500).json({ success: false, message: 'Failed to save booking.', detail: error.message })
  }
})

// --- Simple in-memory idempotency for webhook saves ---
// Prevent duplicate forwards when users click Print/Save multiple times.
// Keyed by serial (quotation/jobcard). TTL keeps memory bounded across time.
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes
const recentSerials = new Map(); // key -> timestamp

// Lightweight cache for GET webhook proxy responses to reduce perceived latency
// Especially useful for staff/account views that poll frequently.
const WEBHOOK_CACHE = new Map(); // key -> { t:number, data:any }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min TTL for faster repeated reads in UI
const WEBHOOK_INFLIGHT = new Map(); // key -> Promise<any>
function cacheKey(webhookUrl, payload){
  try { return `${webhookUrl}|${JSON.stringify(payload||{})}` } catch { return String(webhookUrl||'') }
}
function cacheGet(webhookUrl, payload){
  const k = cacheKey(webhookUrl, payload)
  const e = WEBHOOK_CACHE.get(k)
  if (e && (Date.now() - e.t) < CACHE_TTL_MS) return e.data
  if (e) WEBHOOK_CACHE.delete(k)
  return null
}
function cachePut(webhookUrl, payload, data){
  const k = cacheKey(webhookUrl, payload)
  WEBHOOK_CACHE.set(k, { t: Date.now(), data })
  if (WEBHOOK_CACHE.size > 500) {
    const arr = Array.from(WEBHOOK_CACHE.entries()).sort((a,b)=>a[1].t-b[1].t).slice(0,50)
    for (const [kk] of arr) WEBHOOK_CACHE.delete(kk)
  }
}
function cacheInvalidate(webhookUrl) {
  if (!webhookUrl) return;
  const prefix = String(webhookUrl) + '|';
  const exact = String(webhookUrl);
  for (const k of WEBHOOK_CACHE.keys()) {
    if (k === exact || k.startsWith(prefix)) {
      WEBHOOK_CACHE.delete(k);
    }
  }
}
async function withInflight(key, run){
  const existing = WEBHOOK_INFLIGHT.get(key)
  if (existing) return existing
  const p = (async () => run())()
  WEBHOOK_INFLIGHT.set(key, p)
  try { return await p } finally { WEBHOOK_INFLIGHT.delete(key) }
}

function extractRowsFromWebhookData(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.rows) && data.rows.length > 0) return data.rows
  if (Array.isArray(data.data) && data.data.length > 0) return data.data
  if (Array.isArray(data.rows)) return data.rows
  if (Array.isArray(data.data)) return data.data
  return []
}

function extractTotalFromWebhookData(data) {
  if (!data || typeof data !== 'object') return null
  const keys = ['total', 'count', 'totalRows', 'totalCount']
  for (const key of keys) {
    const n = Number(data[key])
    if (Number.isFinite(n) && n >= 0) return n
  }
  if (data.meta && typeof data.meta === 'object') {
    for (const key of keys) {
      const n = Number(data.meta[key])
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return null
}

function parseIstTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const s = String(value).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  if (s.includes('T') && (s.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(s))) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  const m = s.match(/^(\d{1,4})([/-])(\d{1,2})\2(\d{1,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i)
  if (m) {
    const first = parseInt(m[1], 10)
    const second = parseInt(m[3], 10)
    const third = parseInt(m[4], 10)
    let y
    let month
    let day
    if (m[1].length === 4) {
      y = first
      month = second
      day = third
    } else {
      y = third < 100 ? third + 2000 : third
      day = first
      month = second
    }
    let hh = m[5] ? parseInt(m[5], 10) : 0
    const mm = m[6] ? parseInt(m[6], 10) : 0
    const ss = m[7] ? parseInt(m[7], 10) : 0
    const ap = String(m[8] || '').toUpperCase()
    if (ap === 'PM' && hh < 12) hh += 12
    if (ap === 'AM' && hh === 12) hh = 0
    if (
      y >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
      hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59
    ) {
      const t = Date.UTC(y, month - 1, day, hh, mm, ss) - (5.5 * 60 * 60 * 1000)
      const check = new Date(t + (5.5 * 60 * 60 * 1000))
      if (check.getUTCFullYear() === y && check.getUTCMonth() + 1 === month && check.getUTCDate() === day) return t
    }
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function extractWebhookRowTimestamp(row) {
  if (!row || typeof row !== 'object') return null
  let payload = null
  try {
    const raw = row['Raw Payload'] || row.rawPayload || row.payload || row.Payload
    payload = raw && typeof raw === 'object' ? raw : JSON.parse(String(raw || '{}'))
  } catch {
    payload = null
  }
  const val = row.values || {}
  const candidates = [
    payload?.ts,
    payload?.createdAt,
    payload?.submittedAt,
    payload?.savedAt,
    payload?.updatedAt,
    payload?.formValues?.ts,
    payload?.formValues?.createdAt,
    row['Created At'],
    row['Submitted At'],
    row.Timestamp,
    row.timestamp,
    row.createdAt,
    row.ts,
    row.Time,
    row.Date,
    val['Created At'],
    val['Submitted At'],
    val.Timestamp,
    val.timestamp,
    val.createdAt,
    val.ts,
    val.Time,
    val.Date,
  ]
  for (const value of candidates) {
    const t = parseIstTimestampMs(value)
    if (t) return t
  }
  return null
}

function applyWebhookDateRangeFilter(data, payload) {
  const start = parseIstTimestampMs(payload?.start)
  const end = parseIstTimestampMs(payload?.end)
  if (!start || !end) return data
  const rows = extractRowsFromWebhookData(data)
  if (!rows.length) return data

  const filteredRows = rows.filter((row) => {
    const t = extractWebhookRowTimestamp(row)
    return Boolean(t && t >= start && t <= end)
  })
  
  // Capture original pagination totals to prevent client loop from terminating early
  const originalTotal = data && typeof data === 'object' ? data.total : null
  const originalCount = data && typeof data === 'object' ? data.count : null
  const originalTotalRows = data && typeof data === 'object' ? data.totalRows : null
  const originalTotalCount = data && typeof data === 'object' ? data.totalCount : null

  const merged = mergeRowsIntoWebhookData(data, filteredRows)
  
  if (originalTotal !== null && originalTotal !== undefined) merged.total = originalTotal
  if (originalCount !== null && originalCount !== undefined) merged.count = originalCount
  if (originalTotalRows !== null && originalTotalRows !== undefined) merged.totalRows = originalTotalRows
  if (originalTotalCount !== null && originalTotalCount !== undefined) merged.totalCount = originalTotalCount

  // Recalculate branchSummary total counts based on filteredRows
  if (merged && typeof merged === 'object' && Array.isArray(merged.branchSummary)) {
    const counts = {}
    filteredRows.forEach((r) => {
      const val = (r && r.values) ? r.values : r
      const b = String(val?.Branch || val?.branch || val?.['Branch'] || '').trim().toUpperCase()
      if (b) counts[b] = (counts[b] || 0) + 1
    })
    merged.branchSummary = merged.branchSummary.map((item) => {
      const key = String(item.branch || item.key || '').trim().toUpperCase()
      const totalCount = counts[key] || 0
      return {
        ...item,
        total: totalCount
      }
    }).filter(item => item.total > 0)
  }
  
  return merged
}

function mergeRowsIntoWebhookData(data, rows) {
  const out = (data && typeof data === 'object' && !Array.isArray(data))
    ? { ...data }
    : {}
  if (Array.isArray(data)) return rows
  
  if (out.rows !== undefined) out.rows = rows
  if (out.data !== undefined) out.data = rows
  
  if (out.rows === undefined && out.data === undefined) {
    out.rows = rows
  }
  
  const total = rows.length
  out.total = total
  if ('count' in out) out.count = total
  if ('totalRows' in out) out.totalRows = total
  if ('totalCount' in out) out.totalCount = total
  if ('page' in out && (out.page === undefined || out.page === null)) out.page = 1
  if ('pageNo' in out && (out.pageNo === undefined || out.pageNo === null)) out.pageNo = 1
  return out
}

function stripHeavyFieldsFromRow(row) {
  if (!row || typeof row !== 'object') return row
  const out = { ...row }
  delete out.payload
  delete out.Payload
  delete out.PAYLOAD
  delete out.rawPayload
  if (out.values && typeof out.values === 'object') {
    out.values = { ...out.values }
    delete out.values.payload
    delete out.values.Payload
    delete out.values.PAYLOAD
    delete out.values.rawPayload
  }
  return out
}

function applyLiteWebhookData(data, lite) {
  if (!lite) return data
  if (Array.isArray(data)) return data.map(stripHeavyFieldsFromRow)
  if (!data || typeof data !== 'object') return data
  const out = { ...data }
  if (Array.isArray(out.rows)) out.rows = out.rows.map(stripHeavyFieldsFromRow)
  if (Array.isArray(out.data)) out.data = out.data.map(stripHeavyFieldsFromRow)
  return out
}

function extractSerial(obj) {
  try {
    if (!obj) return null;
    // Direct Booking ID
    const bid = obj.bookingId || obj.data?.bookingId;
    if (bid) return `booking_id_${String(bid).trim()}`;

    // Booking vehicle Chassis
    const chassis = obj.chassisNo || obj.chassis || obj.vehicle?.availabilityInfo?.chassis || obj.vehicle?.chassisNo || obj.data?.chassisNo || obj.data?.vehicle?.availabilityInfo?.chassis;
    if (chassis) {
      const cleanChassis = String(chassis).trim().toUpperCase();
      if (cleanChassis && cleanChassis !== '__ALLOT__' && cleanChassis !== 'ALLOT') {
        return `booking_chassis_${cleanChassis}`;
      }
    }

    // Quotation / JobCard Serials
    if (obj.data?.serialNo) return String(obj.data.serialNo);
    if (obj.data?.jcNo) return String(obj.data.jcNo);
    if (obj.serialNo) return String(obj.serialNo);
    if (obj.jcNo) return String(obj.jcNo);
    if (obj.formValues?.serialNo) return String(obj.formValues.serialNo);
    if (obj.formValues?.jcNo) return String(obj.formValues.jcNo);
    if (obj.payload?.formValues?.serialNo) return String(obj.payload.formValues.serialNo);
    if (obj.payload?.formValues?.jcNo) return String(obj.payload.formValues.jcNo);

    // Mobile + Customer Name fallback for allot bookings
    const mob = obj.mobileNumber || obj.mobile || obj.data?.mobileNumber || obj.data?.mobile;
    const name = obj.customerName || obj.name || obj.data?.customerName || obj.data?.name;
    if (mob && name) {
      const cleanMob = String(mob).replace(/\D/g, '').slice(-10);
      const cleanName = String(name).trim().toLowerCase().replace(/\s+/g, '');
      if (cleanMob && cleanName) return `booking_mob_${cleanMob}_${cleanName}`;
    }
  } catch {}
  return null;
}

function isDuplicateSerial(key) {
  if (!key) return false;
  const ts = recentSerials.get(key);
  const now = Date.now();
  if (ts && now - ts < IDEMPOTENCY_TTL_MS) return true;
  return false;
}

function markSerial(key) {
  if (!key) return;
  recentSerials.set(key, Date.now());
  // prune occasionally
  if (recentSerials.size > 2000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of recentSerials.entries()) { if (v < cutoff) recentSerials.delete(k); }
  }
}

async function axiosRequestWithRetry(method, url, dataOrParams, config, maxRetries = 3, delayMs = 600) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let resp;
      if (method.toUpperCase() === 'GET') {
        const u = new URL(url);
        Object.entries(dataOrParams || {}).forEach(([k, v]) => u.searchParams.append(k, String(v)));
        resp = await axios.get(u.toString(), config);
      } else {
        resp = await axios.post(url, dataOrParams, config);
      }

      if (!String(resp.status).startsWith('2')) {
        throw new Error(`Webhook call failed with status ${resp.status}`);
      }

      const respData = resp.data;
      const isTransientError = respData && respData.ok === false && typeof respData.error === 'string' &&
        /simultaneous invocations|lock|timeout|busy/i.test(respData.error);

      if (isTransientError && attempt < maxRetries) {
        console.warn(`Transient Apps Script error on attempt ${attempt}: ${respData.error}. Retrying in ${delayMs * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      console.warn(`Webhook request failed on attempt ${attempt}: ${err.message}. Retrying in ${delayMs * attempt}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

// Booking via generic webhook (e.g., Google Apps Script Web App)
router.post('/booking/webhook', async (req, res) => {
  try {
    const { webhookUrl, payload, headers, method } = req.body || {}
    if (!webhookUrl) {
      return res.status(400).json({ success: false, message: 'webhookUrl is required.' })
    }
    const httpMethod = (method || 'POST').toUpperCase()
    const action = String(payload?.action || '').toLowerCase()
    const shouldCheckDuplicate = httpMethod !== 'GET' && (!action || action === 'save')
    const liteMode = Boolean(payload?.lite)
    if (shouldCheckDuplicate) {
      const serialKey = extractSerial(payload)
      if (serialKey && isDuplicateSerial(serialKey)) {
        return res.json({ success: true, duplicateSuppressed: true, message: 'Duplicate save suppressed' })
      }
    }
    const config = {
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      validateStatus: () => true,
      timeout: 120000,
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      // allow large JSON payloads (e.g., base64 PDF) to pass through
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
    let resp
    if (httpMethod === 'GET') {
      const cached = cacheGet(webhookUrl, payload)
      if (cached) return res.json({ success: true, forwarded: true, status: 200, data: cached })
      const getPage = async (pagePayload) => {
        const pageCached = cacheGet(webhookUrl, pagePayload)
        if (pageCached) return pageCached
        const inflightKey = cacheKey(webhookUrl, pagePayload)
        return withInflight(inflightKey, async () => {
          const cachedAgain = cacheGet(webhookUrl, pagePayload)
          if (cachedAgain) return cachedAgain
          const pageResp = await axiosRequestWithRetry('GET', webhookUrl, pagePayload, config)
          cachePut(webhookUrl, pagePayload, pageResp.data)
          return pageResp.data
        })
      }

      const requestedPage = Math.max(parseInt(payload?.page || '1', 10) || 1, 1)
      const requestedPageSizeRaw = Math.max(parseInt(payload?.pageSize || payload?.pagesize || '0', 10) || 0, 0)
      const requestedPageSize = requestedPageSizeRaw > 0 ? requestedPageSizeRaw : 10000
      // Only auto-paginate for large one-shot reads (analytics/export style).
      // Keep normal UI pagination (e.g., pageSize 25/50/100) untouched.
      const shouldAutoPaginate = action === 'list' && requestedPage === 1 && (requestedPageSizeRaw === 0 || requestedPageSizeRaw > 100)

      if (!shouldAutoPaginate) {
        const data = applyLiteWebhookData(applyWebhookDateRangeFilter(await getPage(payload || {}), payload || {}), liteMode)
        return res.json({ success: true, forwarded: true, status: 200, data })
      }

      const basePayload = { ...(payload || {}) }
      let allRows = []
      let firstData = null
      let total = null

      // Fetch the first page first to determine total rows
      try {
        firstData = await getPage({ ...basePayload, page: 1 })
      } catch (e) {
        console.error('Failed to fetch page 1 for booking webhook:', e.message)
        return res.status(502).json({ success: false, message: 'Failed to fetch page 1 from booking webhook', detail: e.message })
      }

      if (!firstData) {
        return res.status(502).json({ success: false, message: 'No data returned for page 1 of booking webhook' })
      }

      total = extractTotalFromWebhookData(firstData)
       const firstPageRows = extractRowsFromWebhookData(firstData)
      if (firstPageRows.length > 0) {
        allRows = allRows.concat(firstPageRows)
      }

      const limitRows = total !== null ? Math.min(requestedPageSize, total) : requestedPageSize
      if (firstPageRows.length >= limitRows || (total !== null && firstPageRows.length >= total)) {
        if (allRows.length > requestedPageSize) allRows = allRows.slice(0, requestedPageSize)
        const merged = applyLiteWebhookData(applyWebhookDateRangeFilter(mergeRowsIntoWebhookData(firstData, allRows), payload || {}), liteMode)
        cachePut(webhookUrl, payload, merged)
        return res.json({ success: true, forwarded: true, status: 200, data: merged })
      }

      const pageSizeReturned = firstPageRows.length > 0 ? firstPageRows.length : 100
      const totalPagesNeeded = Math.max(1, Math.ceil(limitRows / pageSizeReturned))

      const promises = []
      for (let p = 2; p <= totalPagesNeeded; p++) {
        promises.push(getPage({ ...basePayload, page: p }).catch(e => {
          console.warn(`Failed to fetch page ${p}:`, e.message);
          return null;
        }))
      }

      if (promises.length > 0) {
        const results = await Promise.all(promises)
        for (let i = 0; i < results.length; i++) {
          const pageData = results[i]
          if (!pageData) continue
          const pageRows = extractRowsFromWebhookData(pageData)
          if (pageRows.length > 0) {
            allRows = allRows.concat(pageRows)
          }
        }
      }

      if (allRows.length > requestedPageSize) allRows = allRows.slice(0, requestedPageSize)
      const merged = applyLiteWebhookData(applyWebhookDateRangeFilter(mergeRowsIntoWebhookData(firstData, allRows), payload || {}), liteMode)
      cachePut(webhookUrl, payload, merged)
      return res.json({ success: true, forwarded: true, status: 200, data: merged })


    } else {
      resp = await axiosRequestWithRetry('POST', webhookUrl, payload || {}, config)
    }
    if (String(resp.status).startsWith('2')) {
      if (shouldCheckDuplicate) {
        const serialKey = extractSerial(payload)
        if (serialKey) markSerial(serialKey)
      }
      if (httpMethod === 'GET') cachePut(webhookUrl, payload, resp.data)
      else cacheInvalidate(webhookUrl)
      return res.json({ success: true, forwarded: true, status: resp.status, data: applyLiteWebhookData(resp.data, liteMode) })
    }
    return res.status(502).json({ success: false, message: 'Webhook call failed', status: resp.status, data: resp.data })
  } catch (error) {
    console.error('Failed to post booking via webhook:', error.response?.data || error)
    return res.status(500).json({ success: false, message: 'Failed to post to webhook.', detail: error.message })
  }
})

// Jobcard via generic webhook (separate route to avoid confusion with booking)
router.post('/jobcard/webhook', async (req, res) => {
  try {
    const { webhookUrl, payload, headers, method } = req.body || {}
    if (!webhookUrl) {
      return res.status(400).json({ success: false, message: 'webhookUrl is required.' })
    }
    const httpMethod = (method || 'POST').toUpperCase()
    const action = String(payload?.action || '').toLowerCase()
    const shouldCheckDuplicate = httpMethod !== 'GET' && (!action || action === 'save')
    const liteMode = Boolean(payload?.lite)
    if (shouldCheckDuplicate) {
      const serialKey = extractSerial(payload)
      if (serialKey && isDuplicateSerial(serialKey)) {
        return res.json({ success: true, duplicateSuppressed: true, message: 'Duplicate save suppressed' })
      }
    }
    const config = {
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      validateStatus: () => true,
      timeout: 120000,
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
    let resp
    if (httpMethod === 'GET') {
      const cached = cacheGet(webhookUrl, payload)
      if (cached) return res.json({ success: true, forwarded: true, status: 200, data: cached })
      const getPage = async (pagePayload) => {
        const pageCached = cacheGet(webhookUrl, pagePayload)
        if (pageCached) return pageCached
        const inflightKey = cacheKey(webhookUrl, pagePayload)
        return withInflight(inflightKey, async () => {
          const cachedAgain = cacheGet(webhookUrl, pagePayload)
          if (cachedAgain) return cachedAgain
          const pageResp = await axiosRequestWithRetry('GET', webhookUrl, pagePayload, config)
          cachePut(webhookUrl, pagePayload, pageResp.data)
          return pageResp.data
        })
      }

      const requestedPage = Math.max(parseInt(payload?.page || '1', 10) || 1, 1)
      const requestedPageSizeRaw = Math.max(parseInt(payload?.pageSize || payload?.pagesize || '0', 10) || 0, 0)
      const requestedPageSize = requestedPageSizeRaw > 0 ? requestedPageSizeRaw : 10000
      // Only auto-paginate for large one-shot reads (analytics/export style).
      // Keep normal UI pagination (e.g., pageSize 25/50/100) untouched.
      const shouldAutoPaginate = action === 'list' && requestedPage === 1 && (requestedPageSizeRaw === 0 || requestedPageSizeRaw > 100)

      if (!shouldAutoPaginate) {
        const data = applyLiteWebhookData(applyWebhookDateRangeFilter(await getPage(payload || {}), payload || {}), liteMode)
        return res.json({ success: true, forwarded: true, status: 200, data })
      }

      const basePayload = { ...(payload || {}) }
      let allRows = []
      let firstData = null
      let total = null

      // Fetch the first page first to determine total rows
      try {
        firstData = await getPage({ ...basePayload, page: 1 })
      } catch (e) {
        console.error('Failed to fetch page 1 for jobcard webhook:', e.message)
        return res.status(502).json({ success: false, message: 'Failed to fetch page 1 from jobcard webhook', detail: e.message })
      }

      if (!firstData) {
        return res.status(502).json({ success: false, message: 'No data returned for page 1 of jobcard webhook' })
      }

      total = extractTotalFromWebhookData(firstData)
      const firstPageRows = extractRowsFromWebhookData(firstData)
      if (firstPageRows.length > 0) {
        allRows = allRows.concat(firstPageRows)
      }

      const limitRows = total !== null ? Math.min(requestedPageSize, total) : requestedPageSize
      if (firstPageRows.length >= limitRows || (total !== null && firstPageRows.length >= total)) {
        if (allRows.length > requestedPageSize) allRows = allRows.slice(0, requestedPageSize)
        const merged = applyLiteWebhookData(applyWebhookDateRangeFilter(mergeRowsIntoWebhookData(firstData, allRows), payload || {}), liteMode)
        cachePut(webhookUrl, payload, merged)
        return res.json({ success: true, forwarded: true, status: 200, data: merged })
      }

      const pageSizeReturned = firstPageRows.length > 0 ? firstPageRows.length : 100
      const totalPagesNeeded = Math.max(1, Math.ceil(limitRows / pageSizeReturned))

      const promises = []
      for (let p = 2; p <= totalPagesNeeded; p++) {
        promises.push(getPage({ ...basePayload, page: p }).catch(e => {
          console.warn(`Failed to fetch page ${p}:`, e.message);
          return null;
        }))
      }

      if (promises.length > 0) {
        const results = await Promise.all(promises)
        for (let i = 0; i < results.length; i++) {
          const pageData = results[i]
          if (!pageData) continue
          const pageRows = extractRowsFromWebhookData(pageData)
          if (pageRows.length > 0) {
            allRows = allRows.concat(pageRows)
          }
        }
      }

      if (allRows.length > requestedPageSize) allRows = allRows.slice(0, requestedPageSize)
      const merged = applyLiteWebhookData(applyWebhookDateRangeFilter(mergeRowsIntoWebhookData(firstData, allRows), payload || {}), liteMode)
      cachePut(webhookUrl, payload, merged)
      return res.json({ success: true, forwarded: true, status: 200, data: merged })
    } else {
      resp = await axiosRequestWithRetry('POST', webhookUrl, payload || {}, config)
    }
    if (String(resp.status).startsWith('2')) {
      if (shouldCheckDuplicate) {
        const serialKey = extractSerial(payload)
        if (serialKey) markSerial(serialKey)
      }
      if (httpMethod === 'GET') cachePut(webhookUrl, payload, resp.data)
      else cacheInvalidate(webhookUrl)
      return res.json({ success: true, forwarded: true, status: resp.status, data: applyLiteWebhookData(resp.data, liteMode) })
    }
    return res.status(502).json({ success: false, message: 'Webhook call failed', status: resp.status, data: resp.data })
  } catch (error) {
    console.error('Failed to post jobcard via webhook:', error.response?.data || error)
    return res.status(500).json({ success: false, message: 'Failed to post to webhook.', detail: error.message })
  }
})

// Note: Stock movements are handled via the GAS proxy (/api/stocks/gas). MongoDB stock routes were removed.

module.exports = router
