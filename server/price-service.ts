import axios from "axios";
import { log } from "./index.js";

interface PriceData {
  price: string;
  change24h: number;
  high24h: string;
  low24h: string;
  volume24h: number;
  quote: string;
  source: string;
}

export async function fetchPriceData(symbol: string): Promise<PriceData | null> {
  const parts = symbol.split('/');
  const base = parts[0].toLowerCase();
  const quote = parts[1]?.toUpperCase() || 'USDT';
  const pair = `${base.toUpperCase()}/${quote}`;

  // Comprehensive validation to prevent API calls for invalid symbols
  const validCryptoBases = [
    // Major coins
    'btc', 'eth', 'sol', 'bnb', 'xrp', 'ada', 'doge', 'avax', 'dot', 'trx',
    'link', 'matic', 'shib', 'ltc', 'bch', 'uni', 'near', 'atom', 'xmr', 'etc',
    'algo', 'vet', 'icp', 'fil', 'hbar', 'flow', 'mana', 'sand', 'axs', 'chz',
    'enj', 'bat', 'storj', 'grt', 'lpt', 'rep', 'nmr', 'aave', 'sushi', 'comp',
    'mkr', 'yfi', 'bal', 'ren', 'lrc', 'omg', 'zrx', 'ant', 'cro', 'cake', 'sxp',
    'alpha', 'inj', 'klv', 'pundix', 'celr', 'chr', 'tkx', 'win', 'hot', 'dent',
    'nano', 'waves', 'zil', 'sc', 'steem', 'strat', 'xem', 'ardr', 'gxs', 'ubq',
    'pivx', 'xvg', 'blk', 'gam', 'nxs', 'ioc', 'sys', 'nav', 'xst', 'nxt', 'burst',
    // Additional popular coins
    'zec', 'pepe', 'xlm', 'bonk', 'usdc', 'usdt', 'busd', 'dai', 'tusd', 'usdp',
    'frax', 'lusd', 'susd', 'eurs', 'xaut', 'paxg', 'wbtc', 'renbtc', 'sbtc',
    'theta', 'icx', 'iost', 'qtum', 'btg', 'zec', 'dash', 'xem', 'btcp', 'bcd',
    'dgb', 'xzc', 'btcd', 'blk', 'rdd', 'tx', 'ftc', 'nxt', 'burst', 'sls', 'xcp',
    'rads', 'dcr', 'xmr', 'vtc', 'nvc', 'ppc', 'mec', 'aur', 'ixc', 'nxt', 'zet',
    'clam', 'sxc', 'qtl', 'enrg', 'ric', 'efc', 'dgc', 'frc', 'nvc', 'btb', 'bqc',
    'yac', 'dmd', 'arg', 'adc', 'xpm', 'gld', 'j', 'rpc', 'spt', 'nka', 'wdc', 'bkc',
    'xmy', 'moo', 'bte', 'xvg', 'cgb', 'sup', 'nrb', 'vrc', 'phs', 'src', 'exc',
    'mue', 'fsc', 'cnc', 'btw', 'bcy', 'frk', 'pzt', 'cap', 'xjo', 'hil', 'kdc',
    'pand', 'aur', 'bqc', 'yac', 'dmd', 'arg', 'adc', 'xpm', 'gld', 'j', 'rpc',
    'spt', 'nka', 'wdc', 'bkc', 'xmy', 'moo', 'bte', 'xvg', 'cgb', 'sup', 'nrb',
    'vrc', 'phs', 'src', 'exc', 'mue', 'fsc', 'cnc', 'btw', 'bcy', 'frk', 'pzt',
    'cap', 'xjo', 'hil', 'kdc', 'pand', 'mzc', 'hil', 'kdc', 'pand', 'mzc', 'anc',
    'trc', 'glc', 'sxc', 'ric', 'efc', 'dgc', 'frc', 'nvc', 'btb', 'bqc', 'yac',
    'dmd', 'arg', 'adc', 'xpm', 'gld', 'j', 'rpc', 'spt', 'nka', 'wdc', 'bkc',
    'xmy', 'moo', 'bte', 'xvg', 'cgb', 'sup', 'nrb', 'vrc', 'phs', 'src', 'exc',
    'mue', 'fsc', 'cnc', 'btw', 'bcy', 'frk', 'pzt', 'cap', 'xjo', 'hil', 'kdc',
    'pand', 'mzc', 'anc', 'trc', 'glc', 'sxc', 'ric', 'efc', 'dgc', 'frc', 'nvc',
    'btb', 'bqc', 'yac', 'dmd', 'arg', 'adc', 'xpm', 'gld', 'j', 'rpc', 'spt',
    'nka', 'wdc', 'bkc', 'xmy', 'moo', 'bte', 'xvg', 'cgb', 'sup', 'nrb', 'vrc',
    'phs', 'src', 'exc', 'mue', 'fsc', 'cnc', 'btw', 'bcy', 'frk', 'pzt', 'cap',
    'xjo', 'hil', 'kdc', 'pand', 'mzc', 'anc', 'trc', 'glc'
  ];

  const validForexBases = ['eur', 'gbp', 'jpy', 'aud', 'cad', 'chf', 'nzd', 'usd'];
  const validQuotes = ['usdt', 'usd', 'btc', 'eth', 'eur', 'gbp', 'jpy', 'aud', 'cad', 'chf', 'nzd'];

  const isValidCrypto = validCryptoBases.includes(base) && validQuotes.includes(quote.toLowerCase());
  // Special case: allow BTC/USD as crypto pair for weekend forex trading
  const isBtcUsd = base === 'btc' && quote.toLowerCase() === 'usd';
  const isValidForex = validForexBases.includes(base) && validForexBases.includes(quote.toLowerCase()) && base !== quote;

  if (!isValidCrypto && !isValidForex && !isBtcUsd) {
    log(`Invalid or unsupported symbol: ${symbol}`, "price-service");
    return null;
  }

  // Prevent same base/quote pairs
  if (base === quote.toLowerCase()) {
    log(`Invalid pair: ${symbol} (same base and quote)`, "price-service");
    return null;
  }

  // 1. Binance (High rate limit)
  try {
    const binanceSymbol = `${base}${quote}`.toUpperCase();
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`, { timeout: 5000 });
    if (res.data && res.data.price) {
      const price = parseFloat(res.data.price);
      return {
        price: price.toString(),
        change24h: 0,
        high24h: price.toString(),
        low24h: price.toString(),
        volume24h: 0,
        quote: quote,
        source: 'Binance'
      };
    }
  } catch (e) { 
    log(`Binance failed for ${symbol}: ${e.message}`, "price-service");
  }

  // 2. CryptoCompare (Alternative reliable source)
  try {
    const res = await axios.get(`https://min-api.cryptocompare.com/data/price?fsym=${base.toUpperCase()}&tsyms=${quote.toUpperCase()}`, { timeout: 5000 });
    if (res.data && res.data[quote.toUpperCase()]) {
      const price = res.data[quote.toUpperCase()];
      return {
        price: price.toString(),
        change24h: 0,
        high24h: price.toString(),
        low24h: price.toString(),
        volume24h: 0,
        quote: quote,
        source: 'CryptoCompare'
      };
    }
  } catch (e) { /* silent fail for fallback */ }

  // 3. Yahoo Finance (Reliable for Forex and Crypto)
  try {
    let yahooSymbol = `${base.toUpperCase()}-${quote.toUpperCase()}`;
    if (['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'].includes(base.toUpperCase())) {
      yahooSymbol = `${base.toUpperCase()}${quote.toUpperCase()}=X`;
    }
    
    const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`, { 
      timeout: 8000, 
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    
    if (res.data?.chart?.result?.[0]) {
      const meta = res.data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      return {
        price: price.toString(),
        change24h: 0,
        high24h: price.toString(),
        low24h: price.toString(),
        volume24h: 0,
        quote: quote,
        source: 'Yahoo Finance'
      };
    }
  } catch (e) { /* silent fail */ }

  // 4. CoinGecko (Fallback) - with rate limiting
  try {
    // Add delay to prevent rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const cgRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${base}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`, { timeout: 5000 });
    let data = cgRes.data[base];
    
    if (!data) {
      // Only try search if base looks like a coin name
      if (base.length > 2) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Additional delay
        const searchRes = await axios.get(`https://api.coingecko.com/api/v3/search?query=${base}`, { timeout: 5000 });
        const coinId = searchRes.data?.coins?.[0]?.id;
        if (coinId) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Additional delay
          const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`, { timeout: 5000 });
          data = priceRes.data[coinId];
        }
      }
    }

    if (data) {
      return {
        price: data.usd.toString(),
        change24h: data.usd_24h_change || 0,
        high24h: (data.usd * 1.02).toString(),
        low24h: (data.usd * 0.98).toString(),
        volume24h: data.usd_24h_vol || 0,
        quote: quote,
        source: 'CoinGecko'
      };
    }
  } catch (e) { log(`CoinGecko failed for ${base}: ${e}`, "price-service"); }

  // 5. DIA (Fallback)
  try {
    const symUpper = base.toUpperCase();
    const res = await axios.get(`https://api.diadata.org/v1/quotation/${symUpper}`, { timeout: 5000 });
    if (res.data && res.data.Price) {
      return {
        price: res.data.Price.toString(),
        change24h: res.data.PricePercentageChange24h || 0,
        high24h: (res.data.Price * 1.02).toString(),
        low24h: (res.data.Price * 0.98).toString(),
        volume24h: res.data.Volume24h || 0,
        quote: quote,
        source: 'DIA'
      };
    }
  } catch (e) { log(`DIA failed for ${base}: ${e}`, "price-service"); }

  return null;
}
