const express = require('express')
const router = express.Router()
const auth = require('../middlewares/authMiddleware')
const Remark = require('../models/remarkModel')
const User = require('../models/userModel')

async function requireBackend(req, res, next) {
  try {
    const u = await User.findById(req.userId).select('role name')
    const role = String(u?.role || '').toLowerCase()
    if (role === 'admin' || role === 'owner' || role === 'owner2' || role === 'backend') { req._actorName = u?.name || 'System'; return next() }
    return res.status(403).json({ success: false, message: 'Forbidden' })
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Unauthorized' })
  }
}

// Upsert a remark for a record
router.post('/upsert', auth, requireBackend, async (req, res) => {
  try {
    const { kind, refId, level, text } = req.body || {}
    const k = String(kind || '').toLowerCase()
    if (!['quotation','jobcard','booking'].includes(k)) return res.status(400).json({ success: false, message: 'kind must be quotation|jobcard|booking' })
    const id = String(refId || '').trim()
    if (!id) return res.status(400).json({ success: false, message: 'refId is required' })
    const lv = String(level || '').toLowerCase()
    if (!['ok','warning','alert'].includes(lv)) return res.status(400).json({ success: false, message: 'level must be ok|warning|alert' })

    const update = {
      level: lv,
      text: String(text || '').trim().slice(0, 240),
      updatedBy: req.userId,
      updatedByName: req._actorName,
    }
    const doc = await Remark.findOneAndUpdate({ kind: k, refId: id }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true })
    return res.json({ success: true, data: doc })
  } catch (err) {
    console.error('POST /remarks/upsert failed', err)
    return res.status(500).json({ success: false, message: 'Failed to save remark' })
  }
})

// Bulk read remarks for a list of refIds
router.get('/bulk', auth, async (req, res) => {
  try {
    const kind = String(req.query.kind || '').toLowerCase()
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!['quotation','jobcard','booking'].includes(kind)) return res.status(400).json({ success: false, message: 'Invalid kind' })
    if (!ids.length) return res.json({ success: true, items: [] })
    const items = await Remark.find({ kind, refId: { $in: ids } }).select('kind refId level text updatedAt updatedByName')
    return res.json({ success: true, items })
  } catch (err) {
    console.error('GET /remarks/bulk failed', err)
    return res.status(500).json({ success: false, message: 'Failed to load remarks' })
  }
})

module.exports = router

