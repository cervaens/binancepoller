const moment = require("moment");

/**
 * Function to parse a klineobject
 * @param {String} symbol
 * @param {Number} openTime
 * @param {String} open
 * @param {String} high
 * @param {String} low
 * @param {String} close
 * @param {String} volume
 * @param {Number} closeTime
 * @param {String} quoteAssetVolume
 * @param {String} numberOfTrades
 * @param {String} takerBuyBaseAssetVolume
 * @param {String} takerBuyQuoteAssetVolume
 * @return {Object} Parsed Object
 */
function klineToObject(symbol, openTime, open, high, low, close,
    volume, closeTime, quoteAssetVolume, numberOfTrades,
    takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume) {
  return {
    symbol,
    openTime,
    open: parseFloat(open),
    high: parseFloat(high),
    low: parseFloat(low),
    close: parseFloat(close),
    volume: parseInt(volume),
    closeTime,
    quoteAssetVolume: parseFloat(quoteAssetVolume),
    numberOfTrades: parseInt(numberOfTrades),
    takerBuyBaseAssetVolume: parseFloat(takerBuyBaseAssetVolume),
    takerBuyQuoteAssetVolume: parseFloat(takerBuyQuoteAssetVolume),
  };
}

/**
 * Function that parses a klineobject but only returns openTime
 * and close inside the object. This is to same precious firebase memory
 * @param {String} symbol
 * @param {Number} openTime
 * @param {String} open
 * @param {String} high
 * @param {String} low
 * @param {String} close
 * @param {String} volume
 * @param {Number} closeTime
 * @param {String} quoteAssetVolume
 * @param {String} numberOfTrades
 * @param {String} takerBuyBaseAssetVolume
 * @param {String} takerBuyQuoteAssetVolume
 * @return {Object} Parsed Object
 */
function klineToCloseObject(symbol, openTime, open, high, low, close,
    volume, closeTime, quoteAssetVolume, numberOfTrades,
    takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume) {
  return {
    openTime,
    close: parseFloat(close),
  };
}

/**
 * Function to send slack messages from an objec
 * @param {Object} values
 */
async function sendSlackMessage(values) {
  const IncomingWebhook = require("@slack/webhook").IncomingWebhook;
  const url = "https://hooks.slack.com/services/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";

  const webhook = new IncomingWebhook(url);
  const type = values.type || "";
  const message = values.message || "";

  const symbol = values.symbol || "";
  // eslint-disable-next-line max-len
  const text = `${symbol} - ${type}: ${message}`;
  const ret = await webhook.send({
    channel: "cc-all",
    icon_emoji: ":male-police-officer:",
    text,
  });
  return ret;
}

/**
 * Function that returns the y for a wanted x, given 2 points of a line
 * @param {Number} x0
 * @param {Number} y0
 * @param {Number} x
 * @param {Number} y
 * @param {Number} wantedX
 * @return {Number} y for wantedX
 */
function calculateLineM(x0, y0, x, y) {
  const minsDiff = moment(x).diff(moment(x0), "minutes") || null;
  if (minsDiff) {
    return (y - y0) / minsDiff;
  }
  return null;
}

/**
 * Function that calculates sma for a specific time
 * @param {Object} data        Long historical data from Binance
 * @param {Number} openTime    The time we're calculating the sma for
 * @param {Number} nrCandles   nrCandles equals sma mean days (7,25,99, etc)
 * @return {Number} sma
 */
function calculateSMAforOpenTime(data, openTime, nrCandles) {
  const summer = (accumulator, currentValue) =>
    accumulator + currentValue.close;
  const filteredArray = data.filter((candle) => candle.openTime <= openTime)
      .slice(nrCandles * -1);
  const sum = filteredArray.reduce(summer, 0);
  return Math.round(sum * 100 / nrCandles) / 100;
}

/**
 * Mainf Function that calculates and stores sma7/25/99
 * @param {Object} data
 * @param {String} symbol
 * @return {Object} result
 */
function calculateSMAs(data, symbol) {
  const result = {sma7: [], sma25: [], sma99: []};
  const kindles = data.map((candle) => klineToCloseObject(symbol, ...candle));

  for ( let i = kindles.length - 1; i >= 99; i -= 1) {
    result.sma7
        .push(calculateSMAforOpenTime(kindles, kindles[i].openTime, 7));
    result.sma25
        .push(calculateSMAforOpenTime(kindles, kindles[i].openTime, 25));
    result.sma99
        .push(calculateSMAforOpenTime(kindles, kindles[i].openTime, 99));
  }
  return result;
}

/**
 *
 * @param {Number} a
 * @param {Number} b
 * @return {int}
 */
function compareMaxPerc(a, b) {
  const aPerc = (a.maxValue - a.lastHighValueMin) / a.maxValue;
  const bPerc = (b.maxValue - b.lastHighValueMin) / b.maxValue;
  if (aPerc < bPerc) {
    return -1;
  }
  if (bPerc < aPerc) {
    return 1;
  }
  return 0;
}

/**
 * Function that returns the y for a wanted x, given 2 points of a line
 * @param {Number} m
 * @param {Number} x0
 * @param {Number} y0
 * @param {Number} x
 * @return {Number} y for wantedX
 */
function calculateLineValueForX(m, x0, y0, x) {
  const minsDiff = moment(x).diff(moment(x0), "minutes") || null;
  if (minsDiff) {
    return m * minsDiff + y0;
  }
  return null;
}

module.exports = {
  klineToObject,
  sendSlackMessage,
  calculateLineM,
  calculateSMAs,
  compareMaxPerc,
  calculateLineValueForX,
};
