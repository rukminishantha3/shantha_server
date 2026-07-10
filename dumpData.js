const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const mongoose = require('mongoose')
const Branch = require('./models/branchModel')
const User = require('./models/userModel')

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI
  await mongoose.connect(uri)
  console.log('Connected to MongoDB')

  const branches = await Branch.find({})
  console.log('--- BRANCHES ---')
  console.log(JSON.stringify(branches, null, 2))

  const owner2Users = await User.find({ role: 'owner2' })
  console.log('--- OWNER2 USERS ---')
  console.log(JSON.stringify(owner2Users, null, 2))

  await mongoose.disconnect()
}

run().catch(console.error)
