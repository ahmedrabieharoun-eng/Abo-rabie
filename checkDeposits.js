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
    console.log("Wallet:", process.env.WALLET_ADDRESS);

    const res = await axios.get(
      `https://tonapi.io/v2/blockchain/accounts/${process.env.WALLET_ADDRESS.trim()}/transactions`,
      {
        params: {
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

    console.log("===== FULL ERROR RESPONSE =====");
    console.log("Status:", error.response?.status);
    console.log("Data:");
    console.log(JSON.stringify(error.response?.data, null, 2));
    console.log("Message:", error.message);
    console.log("================================");

    process.exit(1);
  }
}

checkDeposits();
