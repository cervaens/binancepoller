const admin = require("firebase-admin");
const moment = require("moment");
const utils = require("./utils");

/**
     * Simply stores an alert with the doc content
     * @param {Object} doc
     */
async function storeAlertDoc(doc) {
  const alertsCol = admin.firestore().collection("alerts");
  const result = await alertsCol
      .doc(`${doc.symbol + doc.type + moment().valueOf()}`)
      .set(doc);
  return result;
}

/**
   * This function stores alerts
   * @param {Object} alerts
   */
async function storeAlertHistory(alerts) {
  try {
    const alertsHistoryCol = admin.firestore().collection("alertsHistory");
    for (const alert of alerts) {
      await alertsHistoryCol
          .doc(`${alert.symbol + alert.refValue + alert.date}`)
          .set(alert);
    }
    return alerts.length;
  } catch (error) {
    return error;
  }
}

/**
   * This function will store daily data
   * @param {Object} data
   * @param {Object} crypto
   */
async function storeDailyData(data, crypto) {
  const dailyDataCol = admin.firestore().collection("dailyData");
  const cryptosCol = admin.firestore().collection("cryptosummary");
  const today = moment().utc().startOf("day").valueOf();

  let nrInserts = 0;
  let volumeAccumulator = 0;
  let volumeAvgLast15Days = 0;
  let volumeAvgLast30Days = 0;
  let volumeAvgLast45Days = 0;
  let maxValue = 0;
  let maxValueDate = 0;
  let cryptoDocUpdate ={};

  for ( let i = data.length - 1; i >= 0; i -= 1) {
    const dataFormatted = utils.klineToObject(crypto.symbol, ...data[i]);
    if (i !== data.length - 1) {
      volumeAccumulator += dataFormatted.volume || 0;
    }
    if (data.length - i === 15) {
      volumeAvgLast15Days = volumeAccumulator / 15;
    } else if (data.length - i === 30) {
      volumeAvgLast30Days = volumeAccumulator / 30;
    } else if (data.length - i === 45) {
      volumeAvgLast45Days = volumeAccumulator / 45;
    }
    if (dataFormatted.high > maxValue) {
      maxValue = dataFormatted.high;
      maxValueDate = dataFormatted.openTime;
    }

    if ( Object.keys(cryptoDocUpdate).length === 0 &&
    dataFormatted.open !== today) {
      cryptoDocUpdate = {lastOpenTimeDaily: dataFormatted.openTime,
        lastHighValueDaily: dataFormatted.high,
        lastLowValueDaily: dataFormatted.low,
        lastVolumeDaily: dataFormatted.volume,
        lastCloseValueDaily: dataFormatted.close,
      };
    }

    if (!crypto.lastOpenTimeDaily ||
          (dataFormatted.openTime > crypto.lastOpenTimeDaily &&
          new Date().valueOf() - crypto.lastOpenTimeDaily > 2 * 86400000)) {
      await dailyDataCol.doc(`${crypto.symbol + dataFormatted.openTime}`)
          .set(dataFormatted);
      nrInserts += 1;
    }
  }
  if (crypto.maxValue && crypto.maxValue > maxValue) {
    maxValue = crypto.maxValue;
    maxValueDate = crypto.maxValueDate;
  }
  crypto = {...crypto, ...cryptoDocUpdate};
  try {
    await cryptosCol.doc(`${crypto.symbol}`)
        .update( {...cryptoDocUpdate,
          volumeAvgLast15Days,
          volumeAvgLast30Days,
          volumeAvgLast45Days,
          maxValue,
          maxValueDate,
        });
    return nrInserts;
  } catch (err) {
    return 0;
  }
}
/**
 * Functions that updates crypto currency data in the DB
 * @param {String} symbol
 * @param {Object} updateObj
 */
async function updateCrypto(symbol, updateObj) {
  const cryptosCol = admin.firestore().collection("cryptosummary");

  await cryptosCol.doc(`${symbol}`)
      .update(updateObj);
  return true;
}


module.exports = {
  storeAlertDoc,
  storeAlertHistory,
  storeDailyData,
  updateCrypto,
};
