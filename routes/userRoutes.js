const express = require('express')
const router = express.Router()
const User = require('../models/userModel')
const Branch = require('../models/branchModel')
const mongoose = require('mongoose')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const authMiddleware = require('../middlewares/authMiddleware')
const crypto = require('crypto')
const { sendMail, isMailConfigured } = require('../utils/mailer')

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '60d'
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10)
const RESET_TOKEN_EXP_MINUTES = parseInt(process.env.RESET_TOKEN_EXP_MINUTES || '30', 10)
const APP_URL = (process.env.APP_URL || 'http://localhost:5174').replace(/\/$/, '')
if (!JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET not set; using insecure default for development')
}

// Minimal privileged guard (admin/owner/backend) reused across routes
async function requireAdminOwner(req, res, next) {
  try {
    const userId = String(req.userId || req.body.userId || '')
    if (!/^[0-9a-fA-F]{24}$/.test(userId)) {
      return res.status(401).send({ success: false, message: 'Unauthorized' })
    }
    // Allow open editing when explicitly enabled (use with caution)
    if (process.env.USER_CRUD_OPEN === 'true') return next()
    const me = await User.findById(userId).select('role')
    const role = String(me?.role || '').toLowerCase()
    if (role === 'admin' || role === 'owner' || role === 'owner2' || role === 'backend' || role === 'backend2') return next()
    return res.status(403).send({ success: false, message: 'Forbidden: admin/owner/backend only' })
  } catch (err) {
    console.error('requireAdminOwner error', err)
    return res.status(401).send({ success: false, message: 'Unauthorized' })
  }
}


router.post('/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim()
    const email = String(req.body.email || '').trim().toLowerCase()
    const phone = req.body.phone ? String(req.body.phone).trim() : undefined

    if (!name || !email || !req.body.password) {
      return res.status(400).send({
        success: false,
        message: 'Name, email and password are required.',
      })
    }

    // Build a safe payload — do not allow role/status/branch escalation via public register
    const incomingPassword = String(req.body.password)
    const safeBody = {
      name,
      email,
      ...(phone ? { phone } : {}),
      // role is forced to basic user for self-registration
      role: 'user',
    }

    const duplicate = await User.findOne({
      $or: [
        { email },
        ...(phone ? [{ phone }] : []),
      ],
    })

    if (duplicate) {
      const sameEmail = duplicate.email === email
      const samePhone = phone && duplicate.phone === phone
      let message = 'An account with these details already exists.'
      if (sameEmail && samePhone) {
        message = 'Both email and mobile number are already registered.'
      } else if (sameEmail) {
        message = 'Email is already registered.'
      } else if (samePhone) {
        message = 'Mobile number is already registered.'
      }

      return res.status(409).send({
        success: false,
        message,
      })
    }

    const hashedPassword = await bcrypt.hash(incomingPassword, BCRYPT_SALT_ROUNDS)
    const newUser = new User({ ...safeBody, password: hashedPassword })
    await newUser.save()

    return res.status(201).send({
      success: true,
      message: 'User registered successfully.',
    })
  } catch (err) {
    if (err?.code === 11000) {
      const keys = Object.keys(err.keyPattern || {})
      let message = 'Account already exists.'
      if (keys.includes('email')) message = 'Email is already registered.'
      else if (keys.includes('phone')) message = 'Mobile number is already registered.'
      return res.status(409).send({ success: false, message })
    }

    console.error(err)
    return res.status(500).send({
      success: false,
      message: 'Could not complete registration. Please try again later.',
    })
  }
})

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const user = await User.findOne({
      $or: [
        { email },
        { email: new RegExp('^' + escapedEmail + '$', 'i') }
      ]
    })

    if (!user) {
      return res.status(404).send({
        success: false,
        message: 'User does not exist. Please register.',
      })
    }

    const validPassword = await bcrypt.compare(
      req.body.password,
      user.password
    )

    if (!validPassword) {
      return res.status(401).send({
        success: false,
        message: 'Sorry, invalid password entered!',
      })
    }

    const jwtToken = jwt.sign({ userId: user._id }, JWT_SECRET || 'shantha_motors', {
      expiresIn: JWT_EXPIRES_IN,
    })

    // Update last login timestamp (for dashboard visibility) and clear any forced logout flag
    try {
      await User.updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: new Date() }, $unset: { tokenInvalidAfter: 1 } }
      )
    } catch { /* non-blocking */ }

    // Enrich the user payload so the client can render branch/name immediately without a second fetch
    const userDoc = await User.findById(user._id)
      .select('-password')
      .populate('primaryBranch', 'name code')
      .populate({ path: 'branches', select: 'name code', options: { limit: 3 } })

    const full = userDoc ? userDoc.toJSON() : null
    let branchName = null
    let branchCode = null
    if (userDoc?.primaryBranch && userDoc.primaryBranch.name) {
      branchName = userDoc.primaryBranch.name
      branchCode = userDoc.primaryBranch.code || null
    } else if (Array.isArray(userDoc?.branches) && userDoc.branches.length) {
      branchName = userDoc.branches[0]?.name || null
      branchCode = userDoc.branches[0]?.code || null
    }
    if (full) {
      full.formDefaults = full.formDefaults || {}
      if (!full.formDefaults.staffName) full.formDefaults.staffName = full.name || ''
      if (!full.formDefaults.branchId) full.formDefaults.branchId = userDoc.primaryBranch?._id || (Array.isArray(userDoc.branches) ? userDoc.branches[0]?._id : undefined)
      if (branchName) full.formDefaults.branchName = branchName
      if (branchCode) full.formDefaults.branchCode = String(branchCode).toUpperCase()
    }

    return res.send({
      success: true,
      message: "You've successfully logged in!",
      token: jwtToken,
      user: full || {
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        id: String(user._id),
      },
    })
  } catch (error) {
    console.error(error)
    return res.status(500).send({
      success: false,
      message: 'Unable to process login right now. Please try again later.',
    })
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()

    if (!email) {
      return res.status(400).send({
        success: false,
        message: 'Email is required.',
      })
    }

    const user = await User.findOne({ email })
    if (!user) {
      return res.status(404).send({
        success: false,
        message: 'We could not find an account with that email.',
      })
    }

    const rawToken = crypto.randomBytes(32).toString('hex')
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex')

    user.resetPasswordToken = hashedToken
    user.resetPasswordExpiresAt = new Date(Date.now() + RESET_TOKEN_EXP_MINUTES * 60 * 1000)
    await user.save()

    const resetLink = `${APP_URL}/login?resetToken=${rawToken}`

    const responsePayload = {
      success: true,
      message: 'If the account exists, we have sent password reset instructions.',
    }

    if (isMailConfigured()) {
      try {
        await sendMail({
          to: email,
          subject: 'Reset your Shantha Motors password',
          text: `You requested a password reset. Use the link below to set a new password.\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.`,
          html: `
            <p>You requested a password reset for Shantha Motors.</p>
            <p><a href="${resetLink}" target="_blank" rel="noopener">Click here to choose a new password</a>.</p>
            <p>If the button doesn't work, paste this link in your browser:</p>
            <p><code>${resetLink}</code></p>
            <p>This link expires in ${RESET_TOKEN_EXP_MINUTES} minutes.</p>
          `,
        })
        responsePayload.emailSent = true
      } catch (mailError) {
        console.error('Failed to send reset email:', mailError)
        return res.status(500).send({
          success: false,
          message: 'Could not send reset email. Please try again later.',
        })
      }
    } else if (process.env.NODE_ENV !== 'production') {
      responsePayload.devResetToken = rawToken
      responsePayload.devResetExpiry = user.resetPasswordExpiresAt
    }

    return res.send(responsePayload)
  } catch (error) {
    console.error(error)
    return res.status(500).send({
      success: false,
      message: 'Unable to start password reset. Please try again later.',
    })
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim()
    const password = req.body.password

    if (!token || !password) {
      return res.status(400).send({
        success: false,
        message: 'Token and new password are required.',
      })
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex')
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiresAt: { $gt: new Date() },
    })

    if (!user) {
      return res.status(400).send({
        success: false,
        message: 'Reset link is invalid or has expired.',
      })
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS)
    user.password = hashedPassword
    user.resetPasswordToken = undefined
    user.resetPasswordExpiresAt = undefined
    user.tokenInvalidAfter = new Date()
    await user.save()

    return res.send({
      success: true,
      message: 'Password has been reset successfully.',
    })
  } catch (error) {
    console.error(error)
    return res.status(500).send({
      success: false,
      message: 'Unable to reset password. Please try again later.',
    })
  }
})

// List users (admin/owner only)
router.get('/', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const { q, role, status, branch, limit = 100, page = 1 } = req.query || {}
    const filter = {}
    if (q) {
      const re = new RegExp(String(q), 'i')
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { jobTitle: re },
        { employeeCode: re },
      ]
    }
    if (role) filter.role = role
    if (status) filter.status = status
    if (branch && mongoose.Types.ObjectId.isValid(String(branch))) {
      const b = new mongoose.Types.ObjectId(String(branch))
      filter.$or = [...(filter.$or || []), { primaryBranch: b }, { branches: b }]
    }
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1)
    const [items, total] = await Promise.all([
      User.find(filter)
        .select('-password -resetPasswordToken -resetPasswordExpiresAt')
        .populate('primaryBranch', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      User.countDocuments(filter),
    ])
    return res.json({ success: true, data: { items, total } })
  } catch (err) {
    console.error('GET /users failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch users' })
  }
})

// Public read-only list (no auth). Mirrors filters of the secured list.
router.get('/public', async (req, res) => {
  try {
    const { q, role, status, branch, limit = 100, page = 1 } = req.query || {}
    const filter = {}
    if (q) {
      const re = new RegExp(String(q), 'i')
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { jobTitle: re },
        { employeeCode: re },
      ]
    }
    if (role) filter.role = role
    if (status) filter.status = status
    if (branch && mongoose.Types.ObjectId.isValid(String(branch))) {
      const b = new mongoose.Types.ObjectId(String(branch))
      filter.$or = [...(filter.$or || []), { primaryBranch: b }, { branches: b }]
    }
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1)
    const projection = '-password -resetPasswordToken -resetPasswordExpiresAt'
    const [items, total] = await Promise.all([
      User.find(filter)
        .select(projection)
        .populate('primaryBranch', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      User.countDocuments(filter),
    ])
    return res.json({ success: true, data: { items, total }, public: true })
  } catch (err) {
    console.error('GET /users/public failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch users' })
  }
})

// Admin create user
router.post('/', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const body = req.body || {}
    const name = String(body.name || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    const role = String(body.role || 'user').trim()
    const passwordPlain = String(body.password || '')

    if (!name || !email || !passwordPlain) {
      return res.status(400).json({ success: false, message: 'name, email, password are required' })
    }

    // Unique checks for email/phone
    const dup = await User.findOne({ $or: [{ email }, ...(body.phone ? [{ phone: String(body.phone).trim() }] : [])] })
    if (dup) {
      const sameEmail = dup.email === email
      const samePhone = body.phone && dup.phone === String(body.phone).trim()
      return res.status(409).json({ success: false, message: sameEmail ? 'Email already exists' : samePhone ? 'Phone already exists' : 'User already exists' })
    }

    const payload = {
      name,
      email,
      password: await bcrypt.hash(passwordPlain, BCRYPT_SALT_ROUNDS),
      role,
      status: body.status || 'active',
      ...(body.phone ? { phone: String(body.phone).trim() } : {}),
      ...(body.jobTitle ? { jobTitle: String(body.jobTitle).trim() } : {}),
      ...(body.employeeCode ? { employeeCode: String(body.employeeCode).trim() } : {}),
      ...(body.primaryBranch && mongoose.Types.ObjectId.isValid(String(body.primaryBranch)) ? { primaryBranch: body.primaryBranch } : {}),
      ...(Array.isArray(body.branches) ? { branches: body.branches.filter(v => mongoose.Types.ObjectId.isValid(String(v))) } : {}),
      ...(typeof body.canSwitchBranch === 'boolean' ? { canSwitchBranch: body.canSwitchBranch } : {}),
    }

    const created = await User.create(payload)
    return res.status(201).json({ success: true, message: 'User created', data: created })
  } catch (err) {
    if (err?.code === 11000) {
      const keys = Object.keys(err.keyPattern || {})
      const msg = keys.includes('email') ? 'Email already exists' : keys.includes('phone') ? 'Phone already exists' : 'Duplicate key'
      return res.status(409).json({ success: false, message: msg })
    }
    if (err?.name === 'ValidationError') {
      const details = Object.values(err.errors || {}).map(e => e?.message).join('; ')
      return res.status(400).json({ success: false, message: details || 'Validation failed' })
    }
    console.error('POST /users failed', err)
    return res.status(500).json({ success: false, message: 'Failed to create user' })
  }
})

// Admin update user (full)
router.put('/:id', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }
    const requester = await User.findById(req.userId).select('role')
    const reqRole = String(requester?.role || '').toLowerCase()
    const targetUser = await User.findById(id)
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }
    
    if (['backend', 'backend2'].includes(reqRole)) {
      const targetRole = String(targetUser.role || '').toLowerCase()
      if (['admin', 'owner', 'owner2', 'backend', 'backend2', 'backups'].includes(targetRole)) {
        return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to edit this user.' })
      }
      if (req.body.role && ['admin', 'owner', 'owner2', 'backend', 'backend2', 'backups'].includes(String(req.body.role).toLowerCase())) {
        return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to assign this role.' })
      }
    }
    const body = { ...req.body }
    delete body.userId
    if (body.email) body.email = String(body.email).trim().toLowerCase()
    if (body.name) body.name = String(body.name).trim()
    if (body.phone != null) body.phone = body.phone === '' ? undefined : String(body.phone).trim()
    if (typeof body.canSwitchBranch !== 'undefined') body.canSwitchBranch = !!body.canSwitchBranch

    if (body.password) {
      const requester = await User.findById(req.userId).select('role')
      const reqRole = String(requester?.role || '').toLowerCase()
      if (reqRole !== 'admin') {
        return res.status(403).json({ success: false, message: 'Forbidden: Only admin users can reset passwords.' })
      }
      body.password = await bcrypt.hash(String(body.password), BCRYPT_SALT_ROUNDS)
      body.tokenInvalidAfter = new Date()
    } else {
      delete body.password
    }

    if (Object.prototype.hasOwnProperty.call(body, 'branches')) {
      if (Array.isArray(body.branches)) {
        body.branches = body.branches.filter(v => mongoose.Types.ObjectId.isValid(String(v)))
      } else if (body.branches == null) {
        body.branches = []
      } else {
        delete body.branches
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'primaryBranch')) {
      if (!body.primaryBranch || !mongoose.Types.ObjectId.isValid(String(body.primaryBranch))) {
        body.primaryBranch = undefined
      }
    }

    const updated = await User.findByIdAndUpdate(id, body, { new: true, runValidators: true })
    if (!updated) return res.status(404).json({ success: false, message: 'User not found' })
    return res.json({ success: true, message: 'User updated', data: updated })
  } catch (err) {
    if (err?.code === 11000) {
      const keys = Object.keys(err.keyPattern || {})
      const msg = keys.includes('email') ? 'Email already exists' : keys.includes('phone') ? 'Phone already exists' : 'Duplicate key'
      return res.status(409).json({ success: false, message: msg })
    }
    if (err?.name === 'ValidationError') {
      const details = Object.values(err.errors || {}).map(e => e?.message).join('; ')
      return res.status(400).json({ success: false, message: details || 'Validation failed' })
    }
    console.error('PUT /users/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update user' })
  }
})

// Admin force logout (invalidate tokens)
router.post('/:id/force-logout', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }
    const now = new Date()
    const updated = await User.findByIdAndUpdate(
      id,
      { $set: { tokenInvalidAfter: now } },
      { new: true }
    )
    if (!updated) return res.status(404).json({ success: false, message: 'User not found' })
    return res.json({ success: true, message: 'User will be logged out shortly.' })
  } catch (err) {
    console.error('POST /users/:id/force-logout failed', err)
    return res.status(500).json({ success: false, message: 'Failed to force logout user' })
  }
})

// Admin delete user
router.delete('/:id', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }
    const requester = await User.findById(req.userId).select('role')
    const reqRole = String(requester?.role || '').toLowerCase()
    
    if (['backend', 'backend2'].includes(reqRole)) {
      const targetUser = await User.findById(id)
      if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' })
      const targetRole = String(targetUser.role || '').toLowerCase()
      if (['admin', 'owner', 'owner2', 'backend', 'backend2', 'backups'].includes(targetRole)) {
        return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to delete this user.' })
      }
    }
    const deleted = await User.findByIdAndDelete(id)
    if (!deleted) return res.status(404).json({ success: false, message: 'User not found' })
    return res.json({ success: true, message: 'User deleted' })
  } catch (err) {
    console.error('DELETE /users/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to delete user' })
  }
})

router.get('/get-valid-user', authMiddleware, async (req, res) => {
  try {
    const userDoc = await User.findById(req.body.userId)
      .select('-password')
      .populate('primaryBranch', 'name code')
      // Return all associated branches (name + code + _id) so UI can list them
      .populate({ path: 'branches', select: 'name code' })

    if (!userDoc) {
      return res.status(404).send({ success: false, message: 'User not found' })
    }

    // Soft-touch: bump lastLoginAt if missing or stale (10 min) so dashboards reflect activity
    try {
      const now = new Date()
      const last = userDoc.lastLoginAt ? new Date(userDoc.lastLoginAt) : null
      const stale = !last || (now.getTime() - last.getTime() > 10 * 60 * 1000)
      if (stale) {
        await User.updateOne({ _id: userDoc._id }, { $set: { lastLoginAt: now } })
        // Also reflect in the serialized object we return
        userDoc.lastLoginAt = now
      }
    } catch { /* non-blocking */ }

    const user = userDoc.toJSON()
    let branchName = null
    let branchCode = null
    if (userDoc?.primaryBranch && userDoc.primaryBranch.name) {
      branchName = userDoc.primaryBranch.name
      branchCode = userDoc.primaryBranch.code || null
    } else if (Array.isArray(userDoc?.branches) && userDoc.branches.length) {
      const b0 = userDoc.branches[0]
      branchName = b0?.name || null
      branchCode = b0?.code || null
    }

    if (!user.formDefaults) user.formDefaults = {}
    if (branchName) user.formDefaults.branchName = branchName
    if (branchCode) user.formDefaults.branchCode = String(branchCode).toUpperCase()

    return res.send({
      success: true,
      message: 'You are authorized to go to the protected route!',
      data: user,
    })
  } catch (err) {
    console.error('GET /users/get-valid-user failed', err)
    return res.status(500).send({ success: false, message: 'Could not fetch current user' })
  }
})

// Keep legacy PATCH for role/branch add-set operations

// PATCH user for role/branch updates (admin/owner only)
router.patch('/:id', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const userIdParam = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(userIdParam)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }

    const { role, primaryBranch, branches } = req.body || {}

    const update = { $set: {}, $addToSet: {} }

    if (role) update.$set.role = role
    if (primaryBranch && mongoose.Types.ObjectId.isValid(primaryBranch)) {
      update.$set.primaryBranch = primaryBranch
    }
    if (Array.isArray(branches)) {
      const clean = branches
        .map(String)
        .filter((v) => mongoose.Types.ObjectId.isValid(v))
      if (clean.length) update.$addToSet.branches = { $each: clean }
    }

    if (Object.keys(update.$set).length === 0) delete update.$set
    if (!update.$addToSet.branches) delete update.$addToSet
    if (!update.$set && !update.$addToSet) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' })
    }

    const user = await User.findByIdAndUpdate(userIdParam, update, {
      new: true,
      runValidators: true,
    })
    if (!user) return res.status(404).json({ success: false, message: 'User not found' })

    // Optional reverse link on Branch
    if (primaryBranch && mongoose.Types.ObjectId.isValid(primaryBranch)) {
      await Branch.updateOne({ _id: primaryBranch }, { $addToSet: { staff: user._id } })
    }

    return res.json({ success: true, data: user })
  } catch (err) {
    if (err?.name === 'ValidationError') {
      const details = Object.values(err.errors || {}).map((e) => e?.message).join('; ')
      return res.status(400).json({ success: false, message: details || 'Validation failed' })
    }
    console.error('PATCH /users/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update user' })
  }
})

router.get('/mechanics', authMiddleware, async (req, res) => {
  try {
    const owner = await User.findOne({ role: 'owner' })
    const mechanics = owner?.metadata?.mechanics || []
    return res.json({ success: true, data: mechanics })
  } catch (err) {
    console.error('GET /users/mechanics failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch mechanics' })
  }
})

// POST /users/mechanics - update mechanics list (restricted to Owner/Admin)
router.post('/mechanics', authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.userId)
    const role = String(me?.role || '').toLowerCase()
    if (role !== 'owner' && role !== 'owner2' && role !== 'admin' && role !== 'backend' && role !== 'backend2') {
      return res.status(403).json({ success: false, message: 'Forbidden: Owner, Admin or Backend only' })
    }

    const mechanics = req.body.mechanics
    if (!Array.isArray(mechanics)) {
      return res.status(400).json({ success: false, message: 'Invalid mechanics list' })
    }

    // Find the owner user (Nagesh) to store the data centrally
    let owner = await User.findOne({ role: 'owner' })
    if (!owner) {
      // Fallback to updating the logged-in user if no owner exists
      owner = me
    }

    if (!owner.metadata) owner.metadata = {}
    owner.metadata.mechanics = mechanics
    owner.markModified('metadata')
    await owner.save()

    return res.json({ success: true, message: 'Mechanics updated in database', data: mechanics })
  } catch (err) {
    console.error('POST /users/mechanics failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update mechanics' })
  }
})

module.exports = router;
