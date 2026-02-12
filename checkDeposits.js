const axios = require("axios");
const admin = require("firebase-admin");

// تحميل بيانات Firebase من Secrets
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
      "https://toncenter.com/api/v3/transactions",
      {
        headers: {
          "X-API-Key": process.env.TON_API_KEY
        },
        params: {
          account: process.env.WALLET_ADDRESS.trim(),
          limit: 30
        },
        timeout: 20000
      }
    );

    const transactions = res.data.transactions || [];

    console.log("Transactions fetched:", transactions.length);

    for (let tx of transactions) {

      if (!tx.in_msg) continue;

      const comment = tx.in_msg.message
        ? tx.in_msg.message.trim()
        : null;

      const amount = Number(tx.in_msg.value) / 1e9;
      const hash = tx.hash;

      if (!comment) continue;

      // لو الكومنت رقم فقط
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
          } else {
            console.log("User not found:", comment);
          }
        } else {
          console.log("Transaction already processed:", hash);
        }
      }
    }

    console.log("Deposit check completed.");
    process.exit(0);

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    process.exit(1);
  }
}

checkDeposits();
