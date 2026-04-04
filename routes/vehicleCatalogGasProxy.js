const express = require('express')
const axios = require('axios')

const router = express.Router()

const GAS_URL = process.env.VEHICLE_CATALOG_GAS_URL || 'https://script.google.com/macros/s/AKfycbxHDr58w9Ad3eiMGx4tGaP31PLB4epfpbsk1nX8_AMEz5-8RWLn_gRhMqqzBx5pWNKZ/exec'

router.get('/', async (req, res) => {
  try {
    const params = { ...req.query }
    if (!params.action) params.action = 'list'
    const { data } = await axios.get(GAS_URL, { params })
    return res.json(data)
  } catch (err) {
    const status = err?.response?.status || 500
    return res.status(status).json({
      ok: false,
      message: 'Failed to reach Vehicle Catalog GAS (GET)',
      detail: err?.message || String(err),
    })
  }
})

router.post('/', async (req, res) => {
  try {
    const payload = req.body || {}
    if (!payload.action) payload.action = 'upsert'
    const { data } = await axios.post(GAS_URL, payload)
    return res.json(data)
  } catch (err) {
    const status = err?.response?.status || 500
    return res.status(status).json({
      ok: false,
      message: 'Failed to reach Vehicle Catalog GAS (POST)',
      detail: err?.message || String(err),
    })
  }
})

module.exports = router
