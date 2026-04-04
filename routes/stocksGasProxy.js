const express = require('express')
const axios = require('axios')

const router = express.Router()

// Point this to your deployed Apps Script Web App URL
const GAS_URL = process.env.STOCKS_GAS_URL || 'https://script.google.com/macros/s/AKfycbzTMtDCCcvQrTnrTAf0ZNHHF21aoz4ruPMrmW8gsM5PLHhyCaAxOlcgfIZOOhTa-etX/exec'
const upper = (v) => String(v || '').trim().toUpperCase()

// GET proxy (list/current/pending)
router.get('/', async (req, res) => {
  try {
    const params = { ...req.query }
    if (!params.action) params.action = 'list'
    const { data } = await axios.get(GAS_URL, { params })
    return res.json(data)
  } catch (err) {
    const status = err?.response?.status || 500
    return res.status(status).json({ ok: false, message: 'Failed to reach GAS (GET)', detail: err?.message || String(err) })
  }
})

// POST proxy (create/update/delete/admit/reject)
router.post('/', async (req, res) => {
  try {
    const payload = req.body || {}
    if (!payload.action) payload.action = 'create'
    let { data } = await axios.post(GAS_URL, payload)

    // Fallback for stale movement IDs:
    // if update fails with "Movement not found", resolve latest movement by chassis and retry once.
    const isUpdate = String(payload.action || '').toLowerCase() === 'update'
    const notFound = /movement not found/i.test(String(data?.message || ''))
    const chassisNo = upper(payload?.data?.chassisNo || payload?.data?.Chassis_No)
    const originalChassis = upper(payload?.data?.originalChassis || payload?.data?.OriginalChassis)
    const attemptedId = String(payload?.movementId || payload?.id || '').trim()
    if (isUpdate && data?.ok === false && notFound && chassisNo) {
      let fallbackId = ''
      try {
        const current = await axios.get(GAS_URL, { params: { action: 'current', limit: 3000, page: 1 } })
        const currentRows = Array.isArray(current?.data?.data) ? current.data.data : []
        const snap = currentRows.find((r) => {
          const rowChassis = upper(r?.chassisNo || r?.Chassis_No)
          return rowChassis === chassisNo || (originalChassis && rowChassis === originalChassis)
        })
        fallbackId = String(snap?.lastMovementId || snap?.movementId || '').trim()
      } catch (_) {
        // ignore and continue to next fallback
      }
      if (!fallbackId) {
        try {
          const list = await axios.get(GAS_URL, { params: { action: 'list', limit: 3000, page: 1 } })
          const listRows = Array.isArray(list?.data?.data) ? list.data.data : []
          const mv = listRows.find((r) => {
            const rowChassis = upper(r?.chassisNo || r?.Chassis_No)
            return rowChassis === chassisNo || (originalChassis && rowChassis === originalChassis)
          })
          fallbackId = String(mv?.movementId || mv?.MovementId || '').trim()
        } catch (_) {
          // ignore and return original response
        }
      }
      if (fallbackId && fallbackId !== attemptedId) {
        const retryPayload = { ...payload, movementId: fallbackId }
        const retry = await axios.post(GAS_URL, retryPayload)
        data = retry?.data || data
      }
    }

    return res.json(data)
  } catch (err) {
    const status = err?.response?.status || 500
    return res.status(status).json({ ok: false, message: 'Failed to reach GAS (POST)', detail: err?.message || String(err) })
  }
})

module.exports = router
