const mongoose = require('mongoose');

const MONGO_URI = 'mongodb+srv://knshivakumar139:G0S3YvOYZGSMqaLp@cluster0.ud5oc.mongodb.net/Shantha?retryWrites=true&w=majority&appName=Cluster0';

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const users = await mongoose.connection.db.collection('users').find({}).toArray();
  console.log('\n--- Users ---');
  for (const u of users) {
    console.log(JSON.stringify({
      id: u._id,
      name: u.name,
      role: u.role,
      primaryBranch: u.primaryBranch,
      branches: u.branches,
      formDefaults: u.formDefaults
    }, null, 2));
  }

  const profiles = await mongoose.connection.db.collection('ownerprofiles').find({}).toArray();
  console.log('\n--- Owner Profiles ---');
  for (const p of profiles) {
    console.log(JSON.stringify(p, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(console.error);
