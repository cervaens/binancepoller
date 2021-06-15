// alias firebase="`npm config get prefix`/bin/firebase"

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const https = require("https");
const storeFirestore = require("./storeFirestore");
const utils = require("./utils");
const moment = require("moment");

admin.initializeApp();

const cryptos = [];
const cryptoReference = {};
const alerts = [];
let globalSettings = {};
const excludeList = ["PAXUSDT", "GBPUSDT", "EURUSDT", "BTCSTUSDT", "TUSDUSDT"];


/**
 * Fills in crypto collection.
 */
async function fillCryptoCollection() {
  return new Promise((resolve, reject) => {
    const dailyDataCol = admin.firestore().collection("dailyData");
    const cryptosCol = admin.firestore().collection("cryptosummary");

    let dataExchange = "";
    https.get("https://api.binance.com/api/v3/exchangeInfo", (res) => {
      res.on("data", (d) => {
        dataExchange += d;
      });
      res.on("end", async () => {
        try {
          const exchangeInfo = JSON.parse(dataExchange);

          const usdtSymbols = exchangeInfo.symbols
              .reduce((returnArray, crypto) => {
                if (crypto.symbol.match(/USDT$/) && !crypto.symbol
                    .match(/UPUSDT$|DOWNUSDT$|BEARUSD|BULLUSD|^USD/) &&
            crypto.status === "TRADING") {
                  returnArray.push(crypto.symbol);
                } return returnArray;
              }, []);

          const cryptoSymbols = cryptos.map((elem) => elem.symbol);

          const diffSymbols = cryptoSymbols
              .filter((x) => !usdtSymbols.includes(x));

          for (const symbol of usdtSymbols) {
            await cryptosCol.doc(`${symbol}`)
                .update({symbol: symbol})
                .catch(async (error) => {
                  // console.log('Error: ', error); // does not exists)
                  await cryptosCol.doc(`${symbol}`)
                      .set({symbol: symbol});
                });
          }

          for (const diffSymbol of diffSymbols) {
            await cryptosCol.doc(diffSymbol).delete();
            const delQuery = dailyDataCol
                .where("symbol", "==", diffSymbol);
            await delQuery.get().then(function(querySnapshot) {
              querySnapshot.forEach(function(doc) {
                doc.ref.delete();
              });
            });
          }

          resolve(usdtSymbols.length);
        } catch (error) {
          console.log("Error:" + error);
          reject(error);
        }
      });
    }).on("error", (error) => {
      console.log("Error:" + error);
      reject(error);
    });
  });
}

/**
 * This function stores the cryptocurrency reference data like
 * sma7/25/99
 * @param {Object} data     Binance data
 * @param {Object} crypto   Crypto object
 */
async function storeReferenceDataMemory(data, crypto) {
  let sma7Before = 0;
  let sma7 = 0;

  cryptoReference.result = utils.calculateSMAs(data, crypto.symbol);

  for ( let i = data.length - 1; i >= 0; i -= 1) {
    const dataFormatted = utils.klineToObject(crypto.symbol, ...data[i]);
    if (i === data.length - 1) {
      sma7 += dataFormatted.close;
      cryptoReference.close = dataFormatted.close;
    } else if (i === data.length - 8) {
      sma7Before += dataFormatted.close;
    } else {
      sma7Before += dataFormatted.close;
      sma7 += dataFormatted.close;
    }
  }

  cryptoReference.sma7 = Math.round(sma7 * 100 / 7) / 100;
  cryptoReference.sma7Before = Math.round(sma7Before * 100 / 7) / 100;
  if (!cryptoReference.sma7Diff) {
    cryptoReference.sma7Diff = [];
  }
  cryptoReference.sma7Diff.unshift(Math
      .round((cryptoReference.sma7 - cryptoReference.sma7Before) * 100) /100);

  if (cryptoReference.sma7Diff.length > 100) {
    cryptoReference.sma7Diff.pop();
  }
  return true;
}

/**
 * This function goes through every defined alert for a specific crypto
 * and returns the ones that should generate a notification through slack
 * Should be refactored, could use "case", "assert".
 * @param {Object} allData    minute data coming from Binance
 * @param {Object} crypto     Crypto object
 * @return {Object} Returns array of alerts that should send a notification
 *
 */
async function checkAndSendAlarms(allData, crypto) {
  const triggeredAlarms = [];
  const alertsSymbol = alerts
      .filter((alert) => crypto.symbol === (alert.symbol));

  if (alertsSymbol.length > 0) {
    let last5minsClose = 0;
    let percLast5Min = 0;
    let lastCandle = {};


    for ( let i = 0; i < allData.length; i += 1) {
      const dataFormatted = utils.klineToObject(crypto.symbol, ...allData[i]);

      if (!crypto.lastOpenTimeMin ||
        (dataFormatted.openTime != moment().utc().startOf("minute").valueOf() &&
                dataFormatted.openTime > crypto.lastOpenTimeMin)) {
        lastCandle = dataFormatted;
        percLast5Min = Math.round((lastCandle.close - last5minsClose) *
        100 * 100 / last5minsClose) / 100;
      }
      if (i === 0) {
        last5minsClose = dataFormatted.close;
      }
    }

    const percCloseOpen = Math.round(
        (lastCandle.close - lastCandle.open) *
    100 * 100 / lastCandle.open) / 100;

    const percToHistMax = Math.round((crypto.maxValue - lastCandle.high) *
    100 * 100/ crypto.maxValue) / 100;

    const dailyPerc = Math.round((lastCandle.close -
      crypto.lastCloseValueDaily) * 100 * 100 / crypto.lastCloseValueDaily) /
       100;

    if (dailyPerc < 0 && !globalSettings.sendNotificationForDailyNegative ||
      percLast5Min < 0 && !globalSettings.sendNotificationFor5minNegative) {
      return [];
    }

    for (const alertObject of alertsSymbol) {
      const alert = {...alertObject};
      let push = false;

      if (alert.type === "valueReachedX") {
        if (lastCandle.high >= alert.refValue &&
          lastCandle.low <= alert.refValue) {
          push = true;
        }
      } else if (alert.type === "volMinutePerc" &&
      (crypto.volumeAvgLast45Days || crypto.volumeAvgLast15Days ||
         crypto.volumeAvgLast30Days)) {
        const volRef = Math.min(crypto.volumeAvgLast15Days || Infinity,
            crypto.volumeAvgLast30Days || Infinity,
            crypto.volumeAvgLast45Days || Infinity);

        const volPerc = Math.round(lastCandle.volume *
          100 * 100 / volRef) / 100;
        if (volPerc >= alert.refValue && percCloseOpen > 0 &&
            (
              (!alert.percToHistMax || alert.percToHistMax > percToHistMax) ||
              (alert.secRefValue &&
              (volPerc > alert.secRefValue || percLast5Min > alert.secRefValue))
            )
        ) {
          push = true;
          // eslint-disable-next-line max-len
          alert.message = ` ${volPerc}%, lastPrice: ${lastCandle.close}, PercToHistMax: ${percToHistMax}%`;
        }
      } else if (alert.type === "percLowHighMin" &&
                lastCandle.close >= lastCandle.open) {
        const lowHighPerc = Math.round((lastCandle.high - lastCandle.low) *
        100 * 100 / lastCandle.low) / 100;
        if (lowHighPerc >= alert.refValue) {
          push = true;
          alert.message = ` ${lowHighPerc}, PercToHistMax: ${percToHistMax}%`;
        }
      } else if (alert.type === "percToHistMax") {
        const diffDaysToLastMax = Math.round((((((lastCandle.openTime -
          crypto.maxValueDate) / 1000) / 60) / 60) / 24) * 100) / 100;

        if (crypto.maxValue > lastCandle.high &&
            percToHistMax < alert.refValue &&
            percLast5Min > 0 &&
            !crypto.isCurrentlyInsideRef &&
            lastCandle.openTime - crypto.maxValueDate >
            alert.minDaysToMax * 60 * 60 * 24 * 1000) {
          push = true;
          // eslint-disable-next-line max-len
          alert.message = `${percToHistMax}%, Days to Max: ${diffDaysToLastMax}, maxValue: ${crypto.maxValue}`;
          crypto.isCurrentlyInsideRef = true;
        } else if (crypto.isCurrentlyInsideRef &&
            percToHistMax > alert.refValue) {
          crypto.isCurrentlyInsideRef = false;
        }
      } else if (alert.type === "valueReachedHistMax") {
        if (crypto.maxValue && lastCandle.high >= crypto.maxValue ) {
          push = true;
          crypto.maxValue = lastCandle.high;
          crypto.maxValueDate = lastCandle.openTime;
          await storeFirestore.updateCrypto(crypto.symbol,
              {maxValue: crypto.maxValue,
                maxValueDate: lastCandle.openTime});

          // eslint-disable-next-line max-len
          alert.message = `Last volume: ${lastCandle.volume}, lastHighValue: ${lastCandle.high}`;
        }
      } else if (alert.type === "touchedLine") {
        const valueY = utils.calculateLineValueForX(alert.m, alert.valueX0,
            alert.valueY0, lastCandle.openTime);

        if (valueY >= lastCandle.high) {
          const refValueLine = lastCandle.high +
            (lastCandle.high * alert.percApprox / 100 );
          if (refValueLine >= valueY) {
            push = true;
            // refValue = valueY;
          }
        } else if (valueY <= lastCandle.low) {
          const refValueLine = lastCandle.low -
            (lastCandle.low * alert.percApprox / 100 );
          if (refValueLine <= valueY) {
            push = true;
            // refValue = valueY;
          }
        }
      }

      // Checks if alert is to be pushed and if suspention alert time is valid
      if (push && (!alertObject.suspendTill ||
          (alertObject.suspendTill &&
            alertObject.suspendTill < lastCandle.openTime))) {
        // eslint-disable-next-line max-len
        alert.message += `, PercLast5Min: ${percLast5Min}%, DailyPerc: ${dailyPerc}%, cryptoRefsma7Diff: ${cryptoReference.sma7Diff[0]}`;

        // Print suspendTill finish time diff if it exists
        if (alertObject.suspendTill) {
          const suspendTill = moment().utc()
              .diff(moment(alertObject.suspendTill), "minutes");
          alert.message += `, suspendTillMinsAgo: ${suspendTill}`;
        }

        triggeredAlarms.push({date: lastCandle.openTime,
          type: alert.type, sendNotification: alert.sendNotification,
          symbol: lastCandle.symbol, message: alert.message});


        // suspend alert for next x hours
        if (alertObject.suspensionHours && alertObject.suspensionHours != 0) {
          alertObject.suspendTill = moment().utc()
              .add(alertObject.suspensionHours, "h").valueOf();
        } else if (globalSettings.defaultSuspensionHours) {
          alertObject.suspendTill = moment().utc()
              .add(globalSettings.defaultSuspensionHours, "h").valueOf();
        }
      }
    }
  }

  return triggeredAlarms;
}

/**
     * This functions will store minute data
     * @param {Object} data     kline format
     * @param {Object} crypto   crypto object
     */
async function storeMinuteDataMemory(data, crypto) {
  for ( let i = 0; i < data.length; i += 1) {
    const dataFormatted = utils.klineToObject(crypto.symbol, ...data[i]);

    // Only stores last values
    if (!crypto.lastOpenTimeMin ||
        (dataFormatted.openTime != moment().utc().startOf("minute").valueOf() &&
            dataFormatted.openTime > crypto.lastOpenTimeMin)) {
      crypto.lastOpenTimeMin = dataFormatted.openTime;
      crypto.lastHighValueMin = dataFormatted.high;
      crypto.lastLowValueMin = dataFormatted.low;
      crypto.lastVolumeMin = dataFormatted.volume;
    }
    if (!crypto.maxDailyValue || dataFormatted.high > crypto.maxDailyValue) {
      crypto.maxDailyValue = dataFormatted.high;
    }
  }
  return true;
}

/**
 * Polls Binance minute data for an array of crypto objects.
 * Then it checks if the currency last minute data triggers any alert.
 * Stores Binance data into memory
 * @param {Object} cryptoArray    Array of crypto objects
 * @param {Boolean} checkAlarms   Boolean to decide to check alarms or not
 */
async function pollMinuteData(cryptoArray, checkAlarms) {
  return new Promise((resolve, reject) => {
    let minuteInserts = 0;
    let minuteResponses = 0;
    let storeAlarms = 0;
    cryptoArray.forEach((crypto) => {
      let dataMinute = "";
      https.get(`https://api.binance.com/api/v3/klines?symbol=${crypto.symbol}&interval=1m&limit=6`, (res) => {
        res.on("data", (d) => {
          dataMinute += d;
        });
        res.on("end", async () => {
          try {
            const allData = JSON.parse(dataMinute);

            if (checkAlarms) {
              const triggeredAlarms = await
              checkAndSendAlarms(allData, crypto);

              if (triggeredAlarms.length > 0) {
                await storeFirestore.storeAlertHistory(triggeredAlarms);
                storeAlarms += triggeredAlarms.length;
              }
            }

            const nrMinuteInserts = await
            storeMinuteDataMemory(allData, crypto);
            minuteInserts += nrMinuteInserts;
            minuteResponses += 1;

            // Only resolves when all cryptos have returned, if not it times out
            if (minuteResponses === cryptoArray.length) {
              resolve({minuteResponses, minuteInserts, storeAlarms});
            }
          } catch (error) {
            console.log("Error:" + error);
            reject(error);
          }
        });
      }).on("error", (error) => {
        console.log("Error:" + error);
        reject(error);
      });
    });
  });
}

/**
 * polls the minute data
 * @param {String} cryptoSymbol
 */
async function pollReferenceCrypto(cryptoSymbol) {
  return new Promise((resolve, reject) => {
    const crypto = cryptos
        .find((crypto) => crypto.symbol === cryptoSymbol);
    let dataHour = "";
    https.get(`https://api.binance.com/api/v3/klines?symbol=${crypto.symbol}&interval=30m&limit=200`, (res) => {
      res.on("data", (d) => {
        dataHour += d;
      });
      res.on("end", async () => {
        const allData = JSON.parse(dataHour);
        const result = await storeReferenceDataMemory(allData, crypto);

        resolve(result);
      });
    }).on("error", (error) => {
      console.log("Error:" + error);
      reject(error);
    });
  });
}

/**
 * polls the daily data
 * @param {Object} cryptoArray  Array of crypto objects
 */
async function pollDailyData(cryptoArray) {
  return new Promise((resolve, reject) => {
    let dailyInserts = 0;
    let dailyResponses = 0;
    cryptoArray.forEach((crypto) => {
      let dataDaily = "";
      https.get(`https://api.binance.com/api/v3/klines?symbol=${crypto.symbol}&interval=1d`, (res) => {
        res.on("data", (d) => {
          dataDaily += d;
        });
        res.on("end", async () => {
          try {
            const allData = JSON.parse(dataDaily);
            const nrDailyInserts = await
            storeFirestore.storeDailyData(allData, crypto);
            dailyInserts += nrDailyInserts;
            dailyResponses += 1;

            // Only resolves when all cryptos have returned, if not it times out
            if (dailyResponses === cryptoArray.length) {
              resolve({dailyResponses, dailyInserts});
            }
          } catch (error) {
            console.log("Error:" + error);
            reject(error);
          }
        });
      }).on("error", (error) => {
        console.log("Error:" + error);
        reject(error);
      });
    });
  });
}

/**
 * Main function that polls Binance API for minute data.
 * 1. Reads all global settings from the DB
 * 2. Checks if there are cryptos and alerts defined in memory and if not
 *  it loads them from the DB.
 * 3. Checks if daily data needs to be updated and
 *  if so, polls the related cryptos
 * 4. Checks if there are alert definitions in memory and
 *  if not, it loads them from the DB
 * 5. Polls a reference crypto (Bitcoin) to calculate SMAs
 * 6. Starts the poll process for minute data for all cryptos
 */
async function mainPollMinute() {
  const globalSettingsCol = admin.firestore()
      .collection("globalSettings");

  const cryptosCol = admin.firestore().collection("cryptosummary");
  // Getting all global setting
  const getGlobalSettings = await globalSettingsCol.get();
  getGlobalSettings.forEach((doc) => {
    globalSettings = doc.data();
    globalSettings.id = doc.id;
  });

  const alertsCol = admin.firestore().collection("alerts")
      .where("isEnabled", "==", true)
      .where("alertLevel", "<=", globalSettings.alertLevel);

  if (cryptos.length === 0 || globalSettings.forceLoadCryptos) {
    cryptos.length = 0;
    console.log("Getting cryptos from DB");
    const cryptosFromDB = await cryptosCol.get();

    cryptosFromDB.forEach((cryptoObj) => {
      const crypto = cryptoObj.data();
      const isExcluded = excludeList.includes(crypto.symbol);
      if (!isExcluded && !globalSettings.onlyLoadCryptosWithVolData) {
        cryptos.push(crypto);
      } else if (!isExcluded && crypto.volumeAvgLast15Days &&
          crypto.volumeAvgLast15Days !== 0 &&
          (!globalSettings.volPrice15DLimitToLoadCrypto ||
            crypto.volumeAvgLast15Days * crypto.lastCloseValueDaily >=
            globalSettings.volPrice15DLimitToLoadCrypto)) {
        cryptos.push(crypto);
      } else {
        // console.log("Not including" + crypto.symbol);
      }
    });
    if (globalSettings.forceLoadCryptos) {
      await globalSettingsCol.doc(globalSettings.id)
          .update({forceLoadCryptos: false});
    }
  }

  console.log("Working with " + cryptos.length + " cryptos.");

  const yesterdayOpenTime = moment().utc().subtract(1, "day")
      .startOf("day").valueOf();

  // Identifying which cryptos need to have the daily data polled
  const cryptoUpdateDaily = cryptos
      .filter((crypto) => crypto.lastOpenTimeDaily < yesterdayOpenTime);

  // Poll cryptos that need to have the daily data updated due to
  // being a new day or somehow we didnt yet get this data from Binance
  if (cryptoUpdateDaily.length > 0) {
    console.log("Polling daily for " + JSON.stringify(cryptoUpdateDaily
        .map((crypto) => crypto.symbol)));
    const result = await pollDailyData(cryptoUpdateDaily);

    console.log("Daily Poll finished!" + JSON.stringify(result));
    await globalSettingsCol.doc(globalSettings.id)
        .update({forceLoadCryptos: true});
  }

  const cryptoSymbols = cryptos.map((elem) => elem.symbol);

  // Loading alert definitions
  if (alerts.length === 0 || globalSettings.forceLoadAlerts) {
    alerts.length = 0;
    console.log("Getting alarms from DB");
    const alertsFromDB = await alertsCol.get();
    alertsFromDB.forEach((alertObj) => {
      const alert = alertObj.data();
      if (alert.symbol === "All") {
        cryptoSymbols.forEach((symbol) => {
          const newAlert = {...alert};
          newAlert.symbol = symbol;
          alerts.push(newAlert);
        });
      } else {
        alerts.push(alert);
      }
    });
    if (globalSettings.forceLoadAlerts) {
      await globalSettingsCol.doc(globalSettings.id)
          .update({forceLoadAlerts: false});
    }
  }
  console.log("Working with " + alerts.length + " alerts.");

  await pollReferenceCrypto("BTCUSDT");
  const result = await pollMinuteData(cryptos, true);
  return result;
}

/**
 * Function that polls minute values from Binance
 * This is to be used as a manual call (not scheduled)
 */
exports.pollMinute = functions.https.onRequest(async (request, response) => {
  setTimeout(async () => { // Waiting for Binance to have all minute currencies.
    const result = await mainPollMinute();
    response.send("Poll finished!" + JSON.stringify(result));
  }, 1500);
});

/**
 * Function that polls daily values from Binance
 */
exports.pollDaily = functions.https.onRequest(async (request, response) => {
  const cryptosCol = admin.firestore().collection("cryptosummary");
  const body = request.body;
  functions.logger.info("Polling daily!", {structuredData: true});
  const cryptosFromDB = await cryptosCol.get();

  cryptosFromDB.forEach((cryptoObj) => {
    const crypto = cryptoObj.data();
    cryptos.push(crypto);
  });
  const cryptoSliced = cryptos.slice(body.sliceStart, body.sliceEnd);
  // console.log("Symbols to poll: " + JSON.stringify(cryptoSliced));
  const result = await pollDailyData(cryptoSliced);
  response.send("Poll finished!" + JSON.stringify(result));
});

/**
 * Function that fills in cryptos object from Binance.
 * This call is for now manual, to add new supported currencies  by Binance.
 */
exports.fillInCrypto = functions.https.onRequest(async (request, response) => {
  const cryptosCol = admin.firestore().collection("cryptosummary");

  const cryptosFromDB = await cryptosCol.get();

  cryptosFromDB.forEach((cryptoObj) => {
    const crypto = cryptoObj.data();
    cryptos.push(crypto);
  });

  const result = await fillCryptoCollection();
  response.send("Hello from Firebase!" + result);
});

/**
 * Function that inserts a user custom line into the DB
 * from 2 graph points: (x0,y0) and (x,y)
 * @param {Number} request.body.x0        x0 coordinate
 * @param {Number} request.body.y0        y0 coordinate
 * @param {Number} request.body.x         x coordinate
 * @param {Number} request.body.y         y coordinate
 * @param {String} request.body.symbol    crypto symbol
 *
 */
exports.storeLineAlert = functions.https
    .onRequest(async (request, response) => {
      if (!request.body || !request.body.x0 || !request.body.x ||
        !request.body.y0 || !request.body.y || !request.body.symbol) {
        response.send("Fill in all details of the line!");
      }
      const body = request.body;
      const type = "touchedLine";
      const valueX0 = moment(body.x0).valueOf();
      const valueX = moment(body.x).valueOf();

      const m = utils.calculateLineM(body.x0, body.y0, body.x, body.y);

      await storeFirestore.storeAlertDoc({type, valueX0, valueX,
        valueY0: body.y0,
        valueY: body.y, symbol: body.symbol,
        sendNotification: body.sendNotification || true,
        isEnabled: body.isEnabled || true,
        percApprox: body.percApproximation || 2,
        m});

      response.send("Line stored!");
    });

/**
 * Function that for each insert in the alertHistory table
 * will send a slack notification
 */
exports.createAlertHistory = functions.firestore
    .document("alertsHistory/{docId}")
    .onCreate(async (snap, context) => {
      const newValues = snap.data();
      if (newValues.sendNotification) {
        await utils.sendSlackMessage(newValues);
      }
    });

/**
 * Scheduled cron, run every minute that will call the
 * main function that polls Binance for historical minute data
 */
exports.scheduledFunction = functions.pubsub
    .schedule("* * * * *").onRun(async (context) => {
      const result = await mainPollMinute();
      console.log(JSON.stringify(result));
    });

/**
 * Function that displays in an ordered table the cryptos that are closer
 * to their max historical value
 * @param {Number} request.query.daysToMax    Minimum days to the historical max
 */
exports.getCloseToMax = functions.https
    .onRequest(async (request, response) => {
      const query = request.query;
      const daysToMax = query.daysToMax || 1;

      if (cryptos.length === 0) {
        const cryptosCol = admin.firestore().collection("cryptosummary");
        const cryptosFromDB = await cryptosCol.get();
        cryptosFromDB.forEach((cryptoObj) => {
          const crypto = cryptoObj.data();
          const isExcluded = excludeList.includes(crypto.symbol);
          if (!isExcluded && !globalSettings.onlyLoadCryptosWithVolData) {
            cryptos.push(crypto);
          } else if (!isExcluded && crypto.volumeAvgLast15Days &&
              crypto.volumeAvgLast15Days !== 0 &&
              (!globalSettings.volPrice15DLimitToLoadCrypto ||
                crypto.volumeAvgLast15Days * crypto.lastCloseValueDaily >=
                globalSettings.volPrice15DLimitToLoadCrypto)) {
            cryptos.push(crypto);
          } else {
            // console.log("Not including" + crypto.symbol);
          }
        });
      }
      await pollMinuteData(cryptos, false);

      let responseString = "";
      const sorted = cryptos.sort(utils.compareMaxPerc);
      sorted.forEach((crypto) => {
        const diffDaysToLastMax = Math.round((((((crypto.lastOpenTimeMin -
          crypto.maxValueDate) / 1000) / 60) / 60) / 24) * 100) / 100;
        // eslint-disable-next-line max-len
        if (diffDaysToLastMax > daysToMax) {
          // eslint-disable-next-line max-len
          responseString += `${crypto.symbol},  ${crypto.maxValue}, ${crypto.lastHighValueMin}, ${diffDaysToLastMax}<br>`;
        }
      });


      response.send(`Symbol, MaxValue, LastPrice, Days diff to Max<br>
      ${responseString}`);
    });
