const axios = require('axios');

const GAS_URL = 'https://script.google.com/macros/s/AKfycbzd_eCsHisNZxPoE-GD-4aMKR1oYHRJGK9YiCR-tLQXI3I8OkFccDi9ELhg5LSyOkp7PQ/exec';

async function test() {
  for (const status of ['unsettled', 'settled', 'all']) {
    console.log(`\n--- Fetching for status: ${status} ---`);
    try {
      const resp = await axios.get(GAS_URL, {
        params: { action: 'owner_ledger_list', status: status }
      });
      const data = resp.data;
      console.log(`Success: ${data.success}`);
      if (data.rows) {
        console.log(`Total rows returned: ${data.rows.length}`);
        const sample = data.rows.slice(0, 3);
        console.log('Sample rows:');
        console.log(JSON.stringify(sample, null, 2));

        // Let's count Byadarahalli rows in the response
        const byadarahalliRows = data.rows.filter(r => String(r[3] || '').toLowerCase().includes('byadarahalli'));
        console.log(`Byadarahalli rows count: ${byadarahalliRows.length}`);
        if (byadarahalliRows.length > 0) {
          console.log('Sample Byadarahalli rows:');
          console.log(JSON.stringify(byadarahalliRows.slice(0, 3), null, 2));
        }
      } else {
        console.log('No rows field in response:', data);
      }
    } catch (e) {
      console.error(`Error fetching ${status}:`, e.message);
    }
  }
}

test();
