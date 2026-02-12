const axios = require("axios");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

async function checkDeposits() {
  try {

    console.log("Starting deposit check...");

    const res = await axios.get(
      `https://toncenter.com/api/v2/getTransactions?address=${process.env.WALLET_ADDRESS}&limit=30`,
      {
        headers: { "X-API-Key": process.env.TON_API_KEY },
        timeout: 15000
      }
    );

    const transactions = res.data.result;

    console.log("Transactions fetched:", transactions.length);

    for (let tx of transactions) {

      if (!tx.in_msg) continue;

      const comment = tx.in_msg.message ? tx.in_msg.message.trim() : null;
      const amount = tx.in_msg.value / 1e9;
      const hash = tx.transaction_id.hash;

      if (!comment) continue;

      if (/^\d+$/.test(comment)) {

        const processedRef = db.ref("processed/" + hash);
        const processedSnap = await processedRef.get();

        if (!processedSnap.exists()) {

          const userRef = db.ref("users/" + comment);
          const userSnap = await userRef.get();

          if (userSnap.exists()) {

            const currentBalance = userSnap.val().balance || 0;

            await userRef.update({
              balance: currentBalance + amount
            });

            await processedRef.set(true);

            console.log(`Added ${amount} TON to user ${comment}`);
          }
        }
      }
    }

    console.log("Deposit check completed.");

    process.exit(0);

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

checkDeposits();
