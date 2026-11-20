const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const mongoose = require('mongoose')
const fs = require('fs')
const Branch = require('./models/branchModel')
const User = require('./models/userModel')

async function exportData() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI
  console.log('Connecting to MongoDB Atlas...')
  await mongoose.connect(uri)
  console.log('MongoDB connected successfully.')

  // 1. Export all branches
  const branches = await Branch.find({}).lean()
  console.log(`Fetched ${branches.length} branches from MongoDB.`)
  const branchMap = new Map()
  branches.forEach(b => {
    b.id = String(b._id)
    branchMap.set(String(b._id), b.name)
  })

  // 2. Export all users
  const users = await User.find({}).lean()
  console.log(`Fetched ${users.length} users from MongoDB.`)
  users.forEach(u => {
    u.id = String(u._id)
    // Attach primary branch name & code if populated
    if (u.primaryBranch) {
      const bId = String(u.primaryBranch._id || u.primaryBranch)
      const bObj = branches.find(b => String(b._id) === bId)
      if (bObj) {
        u.primaryBranch = {
          _id: bId,
          id: bId,
          name: bObj.name,
          code: bObj.code,
        }
      }
    }
  })

  fs.writeFileSync(path.join(__dirname, 'exported_branches.json'), JSON.stringify(branches, null, 2))
  fs.writeFileSync(path.join(__dirname, 'exported_users.json'), JSON.stringify(users, null, 2))

  console.log('Successfully saved exported_branches.json and exported_users.json!')
  await mongoose.disconnect()
}

exportData().catch(err => {
  console.error('Export failed:', err)
  process.exit(1)
})
