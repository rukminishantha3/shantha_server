const express = require('express')
const axios = require('axios')
const http = require('http')
const https = require('https')

const router = express.Router()

const GAS_URL = 'https://script.google.com/macros/s/AKfycbxHDr58w9Ad3eiMGx4tGaP31PLB4epfpbsk1nX8_AMEz5-8RWLn_gRhMqqzBx5pWNKZ/exec'

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 100 })
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 100 })

const requestConfig = {
  timeout: 60000,
  httpAgent: HTTP_AGENT,
  httpsAgent: HTTPS_AGENT,
  validateStatus: () => true
}

// 5 minutes cache for vehicle catalog
let catalogCache = null
let catalogCacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

router.get('/', async (req, res) => {
  const params = { ...req.query }
  if (!params.action) params.action = 'list'
  const isListAction = params.action === 'list'
  
  try {
    // Check cache
    if (isListAction && catalogCache && (Date.now() - catalogCacheTime) < CACHE_TTL) {
      return res.json(catalogCache)
    }
    
    const resp = await axios.get(GAS_URL, { params, ...requestConfig })
    if (resp.status >= 200 && resp.status < 300) {
      if (isListAction && resp.data && resp.data.ok) {
        catalogCache = resp.data
        catalogCacheTime = Date.now()
      }
      return res.json(resp.data)
    }
    throw new Error(`Google Web App returned status code ${resp.status}`)
  } catch (err) {
    // If we have an expired cache, return it as fallback instead of failing
    if (isListAction && catalogCache) {
      console.warn('Vehicle catalog fetch failed, serving expired cache fallback:', err.message)
      return res.json(catalogCache)
    }
    return res.status(502).json({
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
    const resp = await axios.post(GAS_URL, payload, requestConfig)
    if (resp.status >= 200 && resp.status < 300) {
      // Invalidate cache on modification
      catalogCache = null
      catalogCacheTime = 0
      return res.json(resp.data)
    }
    throw new Error(`Google Web App returned status code ${resp.status}`)
  } catch (err) {
    return res.status(502).json({
      ok: false,
      message: 'Failed to reach Vehicle Catalog GAS (POST)',
      detail: err?.message || String(err),
    })
  }
})

module.exports = router
