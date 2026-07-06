const mongoose = require('mongoose')

const { Schema } = mongoose

// Centralized role and status options
const ROLE_OPTIONS = [
  'admin',
  'mechanic',
  'staff',
  'employees',
  'owner',
  'owner2',
  'backend', // observability/super-viewer role
  'user', // fallback/basic role
  'backups',
]


const STATUS_OPTIONS = ['active', 'inactive', 'suspended']

// Helper: roles that must be tied to a branch
const BRANCH_BOUND_ROLES = new Set(['staff', 'mechanic', 'employees'])

const userSchema = new Schema(
  {
    // Identity
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    phone: { type: String, unique: true, sparse: true, trim: true }, // optional but unique when present

    // Auth (password is already hashed in route; do not hash here again)
    password: { type: String, required: true },

    // Password reset flow
    resetPasswordToken: { type: String },
    resetPasswordExpiresAt: { type: Date },

    // Employment / Access control
    role: {
      type: String,
      enum: ROLE_OPTIONS,
      required: true,
      default: 'staff', // set 'staff' if you want branch users by default
    },
    jobTitle: { type: String, trim: true },
    employeeCode: { type: String, trim: true }, // unique within a primary branch

    // Branch association
    primaryBranch: { type: Schema.Types.ObjectId, ref: 'Branch' },
    branches: [{ type: Schema.Types.ObjectId, ref: 'Branch' }], // optional multi-branch support
    // For admins/owners who can operate across locations (UI can show a branch switcher)
    canSwitchBranch: { type: Boolean, default: false },

    // Operational
    status: { type: String, enum: STATUS_OPTIONS, default: 'active' },
    lastLoginAt: { type: Date },
    tokenInvalidAfter: { type: Date },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
)

/**
 * Validation: Branch-bound roles must have a primaryBranch set.
 * Also helpful when creating staff accounts to prevent missing branch linkage.
 */
userSchema.path('primaryBranch').validate(function (value) {
  if (BRANCH_BOUND_ROLES.has(this.role)) {
    return !!value
  }
  return true
}, 'primaryBranch is required for staff/mechanic/employees roles')

/**
 * Virtual: defaultBranch
 * - Returns primaryBranch if available, otherwise the first in branches[].
 * - Lets downstream code uniformly read "the branch to use by default".
 */
userSchema.virtual('defaultBranch').get(function () {
  if (this.primaryBranch) return this.primaryBranch
  if (Array.isArray(this.branches) && this.branches.length > 0) return this.branches[0]
  return null
})

/**
 * Virtual: formDefaults
 * - Minimal payload your forms need to auto-fill:
 *   { staffName, branchId }
 * - Consume this in your controllers or client after /me:
 *   const { staffName, branchId } = user.formDefaults
 */
userSchema.virtual('formDefaults').get(function () {
  return {
    staffName: this.name || '',
    branchId: this.defaultBranch || null,
  }
})

// Indexes
userSchema.index({ email: 1 }, { unique: true })
userSchema.index({ primaryBranch: 1 })
userSchema.index({ role: 1 })
// Ensure employeeCode is unique within a primary branch (when both exist)
userSchema.index(
  { employeeCode: 1, primaryBranch: 1 },
  {
    unique: true,
    partialFilterExpression: {
      employeeCode: { $type: 'string' },
      primaryBranch: { $type: 'objectId' },
    },
  }
)

/**
 * Clean JSON output (hide internal fields)
 * Keep password in DB but don't expose it in toJSON.
 * (Your login route can still fetch it with .select('+password') if you later set select:false)
 */
userSchema.set('toJSON', {
  virtuals: true, // include virtuals like formDefaults/defaultBranch in JSON
  transform: function (doc, ret) {
    ret.id = ret._id
    delete ret._id
    delete ret.__v
    delete ret.password
    delete ret.resetPasswordToken
    delete ret.resetPasswordExpiresAt
    return ret
  },
})

const User = mongoose.model('User', userSchema)

module.exports = User
