const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const mongoose = require('mongoose')
const Branch = require('./models/branchModel')
const User = require('./models/userModel')

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI
  await mongoose.connect(uri)
  
  const filter = { status: 'active' }
  const projection = '-password -resetPasswordToken -resetPasswordExpiresAt'
  const items = await User.find(filter)
    .select(projection)
    .populate('primaryBranch', 'name code')
    .sort({ createdAt: -1 })
    
  console.log(items.map(u => ({
    name: u.name,
    role: u.role,
    primaryBranch: u.primaryBranch
  })))

  await mongoose.disconnect()
}

run().catch(console.error)
