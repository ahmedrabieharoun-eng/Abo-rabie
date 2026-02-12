const axios = require("axios");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

async function sendTelegram(userId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
      {
        chat_id: userId,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      }
    );
  } catch (err) {
    console.log("Telegram send error:", err.response?.data || err.message);
  }
}

async function checkDeposits() {
  try {
    console.log("Starting deposit check...");

    const res = await axios.get(
      `https://tonapi.io/v2/blockchain/accounts/${process.env.WALLET_ADDRESS.trim()}/transactions`,
      {
        params: { limit: 30 },
        timeout: 20000
      }
    );

    const transactions = res.data.transactions || [];

    console.log("Transactions fetched:", transactions.length);

    for (let tx of transactions) {

      if (!tx.in_msg) continue;

      const comment =
        tx.in_msg.decoded_body?.text?.trim() ||
        null;

      if (!comment) continue;

      const amount = Number(tx.in_msg.value) / 1e9;
      const hash = tx.hash;

      if (/^\d+$/.test(comment)) {

        const processedRef = db.ref("processed/" + hash);
        const processedSnap = await processedRef.get();

        if (!processedSnap.exists()) {

          const userRef = db.ref("users/" + comment);
          const userSnap = await userRef.get();

          if (userSnap.exists()) {

            const currentBalance = userSnap.val().tonBalance || 0;

            await userRef.update({
              tonBalance: currentBalance + amount
            });

            await processedRef.set(true);

            const txLink = `https://tonviewer.com/transaction/${hash}`;

            await sendTelegram(
              comment,
              `✅ <b>تم استلام إيداع جديد</b>\n\n` +
              `💰 القيمة: <b>${amount} TON</b>\n` +
              `🆔 المعاملة:\n<code>${hash}</code>\n\n` +
              `🔗 <a href="${txLink}">عرض المعاملة</a>`
            );

            console.log(`Added ${amount} TON to user ${comment}`);
          }
        }
      }
    }

    console.log("Deposit check completed.");
    process.exit(0);

  } catch (error) {
    console.log("Error:", error.response?.data || error.message);
    process.exit(1);
  }
}

checkDeposits();
