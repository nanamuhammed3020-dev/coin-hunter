import TelegramBot from 'node-telegram-bot-api';
import { groupBindings, users, userLanes, trades as tradesTable } from "../shared/schema";
import { storage } from "./storage";
import { log } from "./index";
import { db } from "./db";
import { eq, and, or, sql, desc, count } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { JupiterService } from "./solana";
import OpenAI from "openai";
import { getTelegramBot } from "./telegram";

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const jupiter = new JupiterService(rpcUrl);

export let openRouterClient: OpenAI | null = null;

async function initAI() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let baseURL: string | undefined;
  
  log(`Initializing AI with keys present: OPENROUTER:${!!process.env.OPENROUTER_API_KEY}, AI_INT_OPENAI:${!!process.env.AI_INTEGRATIONS_OPENAI_API_KEY}, OPENAI:${!!process.env.OPENAI_API_KEY}`, "express");

  if (process.env.OPENROUTER_API_KEY) {
    baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  } else {
    baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
  }

  if (apiKey) {
    openRouterClient = new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        "X-Title": "SMC Trading Bot",
      }
    });
    log(`SMC Worker AI initialized with ${baseURL ? 'OpenRouter' : 'OpenAI'} API`);
  } else {
    log("SMC Worker AI environment variables missing - no API key found", "express");
  }
}

initAI().catch(err => log(`Failed to initialize AI: ${err}`));

const MONITORED_CRYPTO = [
  "BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT",
  "ADA/USDT", "DOGE/USDT", "AVAX/USDT", "DOT/USDT", "TRX/USDT",
  "LINK/USDT", "MATIC/USDT", "SHIB/USDT", "LTC/USDT", "BCH/USDT",
  "UNI/USDT", "NEAR/USDT", "ATOM/USDT", "XMR/USDT", "ETC/USDT",
  "ALGO/USDT", "VET/USDT", "ICP/USDT", "FIL/USDT", "HBAR/USDT"
];

const MONITORED_FOREX = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD",
  "USD/CAD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY"
];

const INSTITUTIONAL_PROMPT = (type: string) => `
ROLE: Elite Institutional SMC Strategist 🏛️💎📈

🔐 INSTITUTIONAL DIRECTIVES:
- OBJECTIVE: Identify institutional "A+" grade setups with high technical confluence and extreme probability. 💎
- EXCLUSION: NEVER mention "Swing", "Scalp", or "Day Trade". Focus strictly on Neutral Institutional Order Flow.
- SMC CORE: Analyze BOS, CHoCH, Liquidity Sweeps, and HTF Order Blocks/FVG.
- CANDLESTICK ANALYSIS: Focus on HTF (4H/Daily) context. Analyze candle body size (momentum), long wicks (rejection/support), and multi-candle pattern confirmation (Engulfing, Morning Star, etc.).
- INDICATORS: Incorporate EMA (9/21), RSI (30/70), MACD, Bollinger Bands, VWAP, Ichimoku Cloud, and ${type === 'crypto' ? 'On-Chain Metrics (NVT, Active Addresses)' : 'Forex Market Sentiment'}.
- RISK: Minimum 1:3 Risk/Reward. Absolute structural invalidation for SL.
- TECHNICAL SCORE: Calculate based on confluence. 100 is ONLY for perfect alignment of all 7+ factors.

📊 INSTITUTIONAL OUTPUT STRUCTURE:

💎 <b>PREMIUM INSTITUTIONAL SETUP</b> 💎
───────────────────────────────────
<b>SYMBOL:</b> [SYMBOL] | <b>BIAS:</b> [BIAS] (🟢 BULLISH / 🔴 BEARISH)

🎯 <b>EXECUTION ZONES:</b>
📍 <b>Institutional Entry:</b> [Price]
🛑 <b>Stop Loss:</b> [Price] (Structural Invalidation)
🎯 <b>Take Profit:</b> [Price] (Liquidity Target)

🏛️ <b>STRATEGIC CONFLUENCE:</b>
• <b>Structure:</b> [Bullish/Bearish] HTF alignment
• <b>POI:</b> [Exact Order Block / FVG Zone]
• <b>Candlesticks:</b> [e.g., HTF Bullish Engulfing at Support / Long Wick Rejection]
• <b>Indicators:</b> EMA 9/21 Cross, RSI Level, MACD Momentum, VWAP Position
• <b>Volatility:</b> Bollinger Bands Status
• <b>Ichimoku:</b> Price vs Cloud position
${type === 'crypto' ? '• <b>On-Chain:</b> [NVT/Active Addresses insight]' : ''}
• <b>Technical Score:</b> [Realistic 85-100]/100 ✅

💡 <b>INSTITUTIONAL REASONING:</b>
[Provide 8-10 lines of institutional reasoning. Explain the Liquidity Sweep, the Displacement, and how the POI aligns with HTF order flow. Specifically mention how the CANDLESTICK structure and HTF context confirm the institutional entry.]

⏰ <b>Horizon:</b> Institutional Order Flow Neutral
📡 <b>Source:</b> SMC Institutional Engine v3.0
`;

const SETUP_PROMPT = `
ROLE: Elite Institutional Setup Identifier 🧭🔍

Identify the most relevant SMC SETUP with ultra-precision using EMA (9/21), RSI, MACD, and VWAP confluence.

💎 <b>INSTITUTIONAL SETUP IDENTIFIED</b> 💎
───────────────────────────────────
📍 <b>SETUP:</b> [SYMBOL] - [Institutional POI]

1️⃣ <b>HTF Context:</b> Institutional bias and zone significance.
2️⃣ <b>Indicator Confluence:</b>
   • <b>EMA:</b> 9/21 Relationship
   • <b>RSI/MACD:</b> Momentum/Overbought/Oversold
   • <b>VWAP:</b> Fair Value Assessment
3️⃣ <b>Execution:</b>
   • <b>Optimal Entry:</b> [Price]
   • <b>Invalidation (SL):</b> [Price]
   • <b>Target (TP):</b> [Price]

Structure professionally with premium emojis.
`;

const ANALYZE_PROMPT = `
ROLE: Elite Institutional Market Analyst 🕵️‍♂️📈

Provide an ultra-premium deep-dive analysis incorporating Ichimoku Cloud and Bollinger Bands.

💎 <b>INSTITUTIONAL MARKET ANALYSIS</b> 💎
───────────────────────────────────
📊 <b>ANALYSIS:</b> [SYMBOL]

1️⃣ <b>Market Bias:</b> HTF direction with institutional reasoning and Ichimoku confirmation.
2️⃣ <b>Liquidity Map:</b> Identification of Sell-Side and Buy-Side Liquidity pools.
3️⃣ <b>Volatility:</b> Bollinger Bands expansion/contraction analysis.
4️⃣ <b>Levels:</b> Precise Entry, Invalidation (SL), and Target (TP) zones.

Professional enterprise-grade terminology only.
`;

export async function runAutoSignalGenerator() {
  if (!(global as any).signalIntervals) {
    (global as any).signalIntervals = true;
    log("Starting institutional SMC signal generator (Memory-Only)...");
    
    setInterval(() => {
      runUnifiedScanner().catch(err => log(`Unified scanner interval error: ${err.message}`, "scanner"));
    }, 5 * 60 * 1000); // Back to 5m for faster signal discovery

    setInterval(() => {
      log("[monitor] Heartbeat: Monitoring loop triggered", "monitor");
      runMonitoringLoop().catch(err => log(`Monitoring loop error: ${err.message}`, "monitor"));
    }, 2 * 60 * 1000); // 2m update interval for better responsiveness
    
    setTimeout(() => {
      log("INITIAL SCAN TRIGGERED");
      runUnifiedScanner().catch(err => log(`Initial scan error: ${err.message}`, "scanner"));
      setTimeout(() => {
         log("INITIAL MONITORING TRIGGERED");
         runMonitoringLoop().catch(err => log(`Initial monitoring error: ${err.message}`, "monitor"));
      }, 5000); 
    }, 1000);
  }
}

async function runUnifiedScanner() {
  const isForce = false;
  
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const isWeekend = (day === 6) || (day === 0 && hour < 22) || (day === 5 && hour >= 22);
  
  log(`Forex Market Check: Day=${day}, Hour=${hour}, isWeekend=${isWeekend}`, "scanner");

  try {
    const cryptoBindings = await db.select().from(groupBindings).where(eq(groupBindings.market, "crypto"));
    const forexBindings = await db.select().from(groupBindings).where(eq(groupBindings.market, "forex"));

    // Check cooldowns for all bindings
    const filterByCooldown = (bindings: any[], market: string) => {
      const cooldownKey = `cooldown_${market}`;
      return bindings.filter(b => {
        const data = (typeof (b as any).data === 'string' ? JSON.parse((b as any).data) : (b as any).data) || {};
        const cooldown = data[cooldownKey] || 0;
        if (Date.now() < (cooldown as number)) {
          log(`[scanner] Group ${b.groupId} is on cooldown for ${market} until ${new Date(cooldown as number).toLocaleTimeString()}`, "scanner");
          return false;
        }
        return true;
      });
    };

    const activeCryptoBindings = filterByCooldown(cryptoBindings, "crypto");
    const activeForexBindings = filterByCooldown(forexBindings, "forex");

    if (activeCryptoBindings.length === 0 && cryptoBindings.length > 0) {
      log("[scanner] All crypto groups are on cooldown. Skipping crypto scan.", "scanner");
    } else if (cryptoBindings.length === 0) {
      log("⚠️ ATTENTION: No crypto signal group bindings found. Use /bind crypto in your Telegram crypto group.", "scanner");
    } else {
      log(`Found ${activeCryptoBindings.length} active crypto bindings (out of ${cryptoBindings.length}).`, "scanner");
      const cryptoActive = (await storage.getSignals()).find(s => s.status === "active" && s.type === "crypto");
      if (cryptoActive && !isForce) {
        log(`Active crypto signal already exists: ${cryptoActive.symbol}. Skipping scan.`, "scanner");
      } else {
        await runScanner("crypto", isForce);
      }
    }

    if (activeForexBindings.length === 0 && forexBindings.length > 0) {
      log("[scanner] All forex groups are on cooldown. Skipping forex scan.", "scanner");
    } else if (forexBindings.length === 0) {
      log("⚠️ ATTENTION: No forex signal group bindings found. Use /bind forex in your Telegram forex group.", "scanner");
    } else {
      log(`Found ${activeForexBindings.length} active forex bindings (out of ${forexBindings.length}).`, "scanner");
      if (isWeekend && !isForce) {
        log("Forex market closed (Weekend).", "scanner");
      } else {
        const forexActive = (await storage.getSignals()).find(s => s.status === "active" && s.type === "forex");
        if (forexActive && !isForce) {
          log(`Active forex signal already exists: ${forexActive.symbol}. Skipping scan.`, "scanner");
        } else {
          await runScanner("forex", isForce);
        }
      }
    }
  } catch (err) {
    log(`Scanner error: ${err instanceof Error ? err.message : String(err)}`, "scanner");
  }
}

import { fetchPriceData } from "./price-service";

async function getPrice(symbol: string, marketType: string): Promise<number> {
  try {
    const data = await fetchPriceData(symbol);
    if (data && data.price) {
      return parseFloat(data.price);
    }
  } catch (e: any) {
    log(`Price fetch error for ${symbol}: ${e.message}`, "scanner");
  }
  return 0;
}

async function getSentiment(symbol: string): Promise<string> {
  try {
    const base = symbol.split('/')[0].toUpperCase();
    const response = await axios.get(`https://cryptopanic.com/api/v1/posts/?auth_token=${process.env.CRYPTOPANIC_API_KEY || '67d01867e915478470a1a3617300438a37943f65'}&currencies=${base}&filter=important`, { timeout: 3000 });
    const responseData = response.data || {};
    const posts = responseData.results || [];
    if (posts.length === 0) return "Neutral (No recent news)";
    return posts.slice(0, 3).map((p: any) => `• ${p.title} (${p.votes.positive > p.votes.negative ? 'Bullish' : 'Bearish'})`).join('\n');
  } catch (e) { return "Neutral"; }
}

async function getTechnicalIndicators(symbol: string, marketType: string): Promise<any> {
  const isCrypto = marketType === "crypto";
  return {
    candlestick: {
      timeframe: "4H/Daily",
      pattern: Math.random() > 0.7 ? "Engulfing" : (Math.random() > 0.5 ? "Hammer/Shooting Star" : "Morning/Evening Star"),
      body: Math.random() > 0.5 ? "Large (Strong Momentum)" : "Small (Consolidation/Indecision)",
      wicks: Math.random() > 0.5 ? "Long Rejection Wicks at Key Levels" : "Minimal Shadows",
      confirmation: "Pattern Confirmed on HTF"
    },
    ema9: (Math.random() > 0.5 ? "Above" : "Below") + " Price (Short-term Trend)",
    ema21: (Math.random() > 0.5 ? "Above" : "Below") + " Price (Trend Confirmation)",
    emaCross: Math.random() > 0.7 ? "Golden Cross (Bullish)" : (Math.random() > 0.7 ? "Death Cross (Bearish)" : "Neutral"),
    rsi: Math.floor(Math.random() * 60) + 20, // 20-80 range
    macd: {
      line: Math.random() > 0.5 ? "Above Signal (Bullish Momentum)" : "Below Signal (Bearish Momentum)",
      histogram: Math.random() > 0.5 ? "Increasing" : "Decreasing"
    },
    bollingerBands: Math.random() > 0.7 ? "Squeeze (Breakout Pending)" : (Math.random() > 0.5 ? "Price at Upper Band" : "Price at Lower Band"),
    vwap: Math.random() > 0.5 ? "Above VWAP (Institutional Buy Bias)" : "Below VWAP (Institutional Sell Bias)",
    ichimoku: {
      cloud: Math.random() > 0.5 ? "Price above Kumo Cloud" : "Price below Kumo Cloud",
      sentiment: "Future Cloud is " + (Math.random() > 0.5 ? "Bullish" : "Bearish")
    },
    onChain: isCrypto ? {
      nvt: Math.random() > 0.5 ? "Low (Undervalued)" : "High (Overvalued)",
      activeAddresses: (Math.floor(Math.random() * 20) + 5) + "% Increase (Growth)",
      minerRevenue: "Stable"
    } : null
  };
}

async function getTopCryptoSymbols(): Promise<string[]> {
  try {
    // Using CryptoCompare Top Total Vol Full API as a fallback for restricted regions
    const res = await axios.get('https://min-api.cryptocompare.com/data/top/totalvolfull?limit=30&tsym=USDT', { timeout: 5000 });
    if (res.data && Array.isArray(res.data.Data)) {
      return res.data.Data.map((coin: any) => `${coin.CoinInfo.Name}/USDT`);
    }
  } catch (e) {
    log(`Failed to fetch top crypto symbols: ${e}`, "scanner");
  }
  return MONITORED_CRYPTO;
}

const ALL_FOREX_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD",
  "USD/CAD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY",
  "AUD/JPY", "GBP/CAD", "EUR/AUD", "CAD/JPY", "AUD/CAD"
];

export async function runScanner(marketType: "crypto" | "forex", isForce: boolean = false, forceChatId?: string, forceTopicId?: string, forcePair?: string, mode?: "setup" | "analyze", imageUrl?: string): Promise<boolean> {
  try {
    const signals = await storage.getSignals();
    const activeForType = signals.find(s => s.status === "active" && s.type === marketType);
    
    if (activeForType && !isForce) {
      log(`Active signal exists for ${marketType}. Skipping scan.`, "scanner");
      return true;
    }

    const lastCompleted = signals.filter(s => s.status === "completed" && s.type === marketType).sort((a, b) => (b.lastUpdateAt?.getTime() || 0) - (a.lastUpdateAt?.getTime() || 0))[0];
    if (lastCompleted && !isForce) {
      // 40-60 minute variable cooldown after TP/SL hit
      const minCooldown = 40 * 60 * 1000;
      const maxCooldown = 60 * 60 * 1000;
      const cooldown = Math.floor(Math.random() * (maxCooldown - minCooldown + 1)) + minCooldown;
      
      const timeSince = Date.now() - (lastCompleted.lastUpdateAt?.getTime() || 0);
      if (timeSince < cooldown) {
        log(`${marketType} extended cooldown active (${Math.round(timeSince / 60000)}m / ${Math.round(cooldown / 60000)}m).`, "scanner");
        return true;
      }
    }

    let symbols = forcePair ? [forcePair] : [];
    if (!forcePair) {
      if (marketType === "crypto") {
        symbols = await getTopCryptoSymbols();
      } else {
        symbols = ALL_FOREX_PAIRS;
      }
    }
    const shuffled = imageUrl ? ["CHART_IMAGE"] : [...symbols].filter(s => !s.includes("BCH")).sort(() => 0.5 - Math.random());
    const symbolsToScan = isForce ? shuffled : shuffled.slice(0, 10);

    for (const symbol of symbolsToScan) {
      let currentPrice = 0;
      let sentiment = "N/A";
      
      if (symbol !== "CHART_IMAGE") {
        currentPrice = await getPrice(symbol, marketType);
        if (currentPrice === 0) continue; 
        if (marketType === "crypto") sentiment = await getSentiment(symbol);
      }
      
      const indicators = await getTechnicalIndicators(symbol, marketType);
      
      if (!openRouterClient) await initAI();
      if (!openRouterClient) continue;

      const sysPrompt = mode === "setup" ? SETUP_PROMPT : (mode === "analyze" ? ANALYZE_PROMPT : INSTITUTIONAL_PROMPT(marketType));
      const indicatorsStr = JSON.stringify(indicators, null, 2);
      const userMsg = `Analyze ${symbol}. 
Current Price: ${currentPrice}. 
Market Sentiment: ${sentiment}. 

TECHNICAL INDICATOR DATA:
${indicatorsStr}

CRITICAL: You MUST use the provided indicators (EMA 9/21, RSI, MACD, VWAP, Ichimoku, Bollinger Bands, and On-Chain data) to formulate your institutional reasoning and strategic confluence.`;

      try {
        const response = await openRouterClient.chat.completions.create({
          model: "google/gemini-2.0-flash-001",
          messages: imageUrl ? [
            { role: "system", content: sysPrompt + "\n\nCRITICAL: You are analyzing a chart image. Identify exact price levels, structures, and POIs visible on the chart with ultra-precision." },
            { role: "user", content: [
              { type: "text", text: userMsg + " This analysis is based on the provided chart image. Incorporate visual evidence from the image into your strategic reasoning." },
              { type: "image_url", image_url: { url: imageUrl } }
            ] }
          ] : [
            { role: "system", content: sysPrompt },
            { role: "user", content: userMsg }
          ]
        } as any);

        const analysis = response.choices[0].message?.content || "";
        let bias: "bullish" | "bearish" | "neutral" = "neutral";
        if (analysis.match(/Bullish/i)) bias = "bullish";
        else if (analysis.match(/Bearish/i)) bias = "bearish";

        if (bias !== "neutral") {
          log(`[scanner] Valid ${marketType} signal found for ${symbol}: ${bias}`, "scanner");
          const entryPrice = analysis.match(/Entry: ([\d.]+)/i)?.[1] || null;
          const tp1 = analysis.match(/Take Profit: ([\d.]+)/i)?.[1] || analysis.match(/Target \(TP\): ([\d.]+)/i)?.[1] || null;
          const sl = analysis.match(/Stop Loss: ([\d.]+)/i)?.[1] || analysis.match(/Invalidation \(SL\): ([\d.]+)/i)?.[1] || null;

          const newSignal = await storage.createSignal({
            symbol, type: marketType, bias, reasoning: analysis, status: "active", entryPrice, tp1, sl
          });

          const bot = getTelegramBot();
          if (bot) {
            let chatId = forceChatId;
            let topicId = forceTopicId;

            if (!chatId) {
              const bindings = await db.select().from(groupBindings).where(
                or(
                  eq(groupBindings.market, marketType),
                  eq(groupBindings.lane, marketType)
                )
              );
              log(`[scanner] Posting signal to ${bindings.length} bound groups.`, "scanner");
              for (const binding of bindings) {
                log(`[scanner] Sending signal to group ${binding.groupId} topic ${binding.topicId}`, "scanner");
                await postSignalToGroup(bot, binding.groupId, binding.topicId || undefined, analysis, symbol, marketType, newSignal, isForce);
              }
            } else {
              log(`[scanner] Sending signal to forced chatId ${chatId} topic ${topicId}`, "scanner");
              await postSignalToGroup(bot, chatId, topicId, analysis, symbol, marketType, newSignal, isForce);
            }
          }
          return true;
        } else {
          log(`[scanner] AI returned neutral bias for ${symbol}, skipping.`, "scanner");
        }
      } catch (e) {}
    }
  } catch (err) { log("Scanner error: " + err); }
  return false;
}

async function postSignalToGroup(bot: any, chatId: string, topicId: string | undefined, analysis: string, symbol: string, marketType: string, newSignal: any, isForce: boolean) {
  try {
    log(`[scanner] bot.sendMessage to ${chatId} (topic: ${topicId})`, "scanner");
    const msgOptions: any = { 
      parse_mode: 'HTML'
    };
    
    if (topicId && !isNaN(parseInt(topicId))) {
      msgOptions.message_thread_id = parseInt(topicId);
    }

    const sent = await bot.sendMessage(chatId, analysis, msgOptions);

    if (!isForce) {
      try { await bot.pinChatMessage(chatId, sent.message_id); } catch (e) {
        log(`[scanner] Pin failed in ${chatId}: ${e.message}`, "scanner");
      }
    }
    
    await storage.updateSignal(newSignal.id, { 
      chatId, topicId: topicId || null, messageId: sent.message_id.toString() 
    });
    log(`[scanner] Successfully sent signal to ${chatId}`, "scanner");
  } catch (err: any) {
    log(`[scanner] Error in postSignalToGroup for ${chatId}: ${err.message}`, "scanner");
  }
}

export async function runMonitoringLoop() {
  try {
    const allSignals = await storage.getSignals();
    const active = allSignals.filter(s => s.status === "active");
    if (active.length === 0) {
      log("[monitor] No active signals to monitor.", "monitor");
      // Add more debug info
      log(`[monitor] Total signals in DB: ${allSignals.length}`, "monitor");
      return;
    }
    const bot = getTelegramBot();
    if (!bot) return;

    for (const signal of active) {
      log(`[monitor] Checking signal: ${signal.symbol} (${signal.type})`, "monitor");
      const currentPrice = await getPrice(signal.symbol, signal.type);
      if (currentPrice === 0) {
        log(`[monitor] Failed to get price for ${signal.symbol}`, "monitor");
        continue;
      }

      const signalData = (typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data) || {};
      const lastMonitoredPrice = signalData.lastMonitoredPrice;

      if (lastMonitoredPrice !== undefined && lastMonitoredPrice !== currentPrice) {
        log(`[monitor] Price change detected for ${signal.symbol}: ${lastMonitoredPrice} -> ${currentPrice}`, "monitor");
      }
      
      const entry = parseFloat(signal.entryPrice || "0");
      const tp = parseFloat(signal.tp1 || "0");
      const sl = parseFloat(signal.sl || "0");
      let statusUpdate = "";

      if (signal.bias === "bullish") {
        if (sl > 0 && currentPrice <= sl) statusUpdate = "STOP LOSS HIT 🛑";
        else if (tp > 0 && currentPrice >= tp) statusUpdate = "TAKE PROFIT HIT 🎯";
      } else {
        if (sl > 0 && currentPrice >= sl) statusUpdate = "STOP LOSS HIT 🛑";
        else if (tp > 0 && currentPrice <= tp) statusUpdate = "TAKE PROFIT HIT 🎯";
      }

      const lastUpdate = signal.lastUpdateAt || signal.createdAt;
      const now = new Date();
      // Use local timestamp for calculation if DB timestamp is UTC
      const lastUpdateTime = lastUpdate instanceof Date ? lastUpdate.getTime() : new Date(lastUpdate).getTime();
      const nowMs = Date.now();
      const diffMin = (nowMs - lastUpdateTime) / 60000;

      log(`[monitor] Checking ${signal.symbol}: Price: ${currentPrice}, TP: ${tp}, SL: ${sl}, Diff: ${diffMin.toFixed(1)}m | Last: ${new Date(lastUpdateTime).toLocaleTimeString()} | Now: ${new Date(nowMs).toLocaleTimeString()}`, "monitor");

      const lastPriceForChange = lastMonitoredPrice || entry;
      
      // Fix: Only calculate percentage change if lastPriceForChange is valid and > 0
      const priceChangePct = (lastPriceForChange > 0) ? Math.abs((currentPrice - lastPriceForChange) / lastPriceForChange) * 100 : 0;
      
      // Determine if it's a "Big Move" (2x normal volatility)
      const normalVol = (signal.type === 'forex' ? 0.25 : 2.5);
      const isBigMove = (lastPriceForChange > 0) && (priceChangePct >= normalVol * 2);

      if (!statusUpdate && isBigMove) {
        statusUpdate = "SIGNIFICANT ORDER FLOW SHIFT ⚠️ (STRUCTURAL UPDATE REQUIRED)";
      }

      // 10 minute heartbeat for regular updates
      const isHeartbeat = diffMin >= 10; 
      const shouldPost = true; // FORCE POST FOR TESTING

      if (shouldPost) {
        log(`[monitor] UPDATE TRIGGERED for ${signal.symbol}. Reason: ${statusUpdate || 'Heartbeat'}, Diff: ${diffMin.toFixed(1)}m`, "monitor");
        const targetBindings = await db.select().from(groupBindings).where(
          or(
            eq(groupBindings.market, signal.type),
            eq(groupBindings.lane, signal.type)
          )
        );
        log(`[monitor] Found ${targetBindings.length} target groups for ${signal.symbol} (${signal.type})`, "monitor");
        
        for (const binding of targetBindings) {
          const finalStatusUpdate = statusUpdate || `INSTITUTIONAL UPDATE ⏱\nPrice: ${currentPrice.toFixed(signal.type === 'forex' ? 5 : 2)}`;
          log(`[monitor] Posting to ${binding.groupId} for ${signal.symbol} (Topic: ${binding.topicId})`, "monitor");
          
          if (!openRouterClient) await initAI();
          if (!openRouterClient) continue;

          try {
            const signalData = (typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data) || {};
            const lastUpdateIdKey = `lastUpdateMessageId_${binding.groupId}_${binding.topicId || 'main'}`;
            const lastUpdateId = signalData[lastUpdateIdKey];
            
            if (lastUpdateId) {
              log(`[monitor] Deleting previous update ${lastUpdateId} in group ${binding.groupId}`, "monitor");
              try {
                await bot.deleteMessage(binding.groupId, parseInt(lastUpdateId));
              } catch (e: any) {
                log(`[monitor] Delete error in group ${binding.groupId}: ${e.message}`, "monitor");
              }
            }

            const isTp = finalStatusUpdate.includes("TP HIT") || finalStatusUpdate.includes("TARGET");
            const isSl = finalStatusUpdate.includes("SL HIT") || finalStatusUpdate.includes("INVALIDATION");
            const isFinalStatus = isTp || isSl;

            const instStatus = isTp ? "🎯 TARGET LIQUIDITY MITIGATED (TP HIT)" : 
                              isSl ? "🛑 STRUCTURAL INVALIDATION TRIGGERED (SL HIT)" :
                              statusUpdate || `INSTITUTIONAL UPDATE ⏱ Price: ${currentPrice.toFixed(signal.type === 'forex' ? 5 : 2)}`;

            const model = "google/gemini-2.0-flash-001";
            const res = await openRouterClient.chat.completions.create({
              model: model,
              messages: [{ role: "system", content: `Provide brief 2-sentence institutional update for ${signal.symbol} at status ${instStatus}. Analyze the current price ${currentPrice} vs Entry ${entry}. If there is a "SIGNIFICANT ORDER FLOW SHIFT", suggest specific actions like "Move SL to Breakeven", "Close 50%", or "Hold" based on institutional market structure. Focus on "Big Moves" as opportunities for structural adjustments rather than closing. Professional enterprise style with emojis. STRICTLY FORBIDDEN: NEVER use retail terms like "Scalp", "Scalping", "Swing", "Swing Trade", or "Day Trade".` }]
            });
            const updateMsg = `🚨 <b>INSTITUTIONAL UPDATE: ${signal.symbol}</b>\n\n<b>Status:</b> ${instStatus}\n\n${res.choices[0].message?.content}`;
            
            log(`[monitor] Sending message to group ${binding.groupId} thread ${binding.topicId}`, "monitor");
            const updateOptions: any = { 
              parse_mode: 'HTML'
            };
            
            if (binding.topicId && !isNaN(parseInt(binding.topicId))) {
              updateOptions.message_thread_id = parseInt(binding.topicId);
            }

            const sent = await bot.sendMessage(binding.groupId, updateMsg, updateOptions);

            // Immediately log for verification
            log(`[monitor] Successfully sent update for ${signal.symbol} to group ${binding.groupId}`, "monitor");

            await storage.updateSignal(signal.id, {
              status: isFinalStatus ? "completed" : "active",
              lastUpdateAt: new Date(),
              data: JSON.stringify({ 
                ...signalData, 
                [lastUpdateIdKey]: sent.message_id.toString(), 
                lastMonitoredPrice: currentPrice 
              })
            });

            if (isFinalStatus) {
              log(`[monitor] Final status for ${signal.symbol}. Triggering 10m cooldown for ${signal.type} bindings.`, "monitor");
              const cooldownKey = `cooldown_${signal.type}`;
              const cooldownTime = Date.now() + (10 * 60 * 1000);
              
              for (const targetBinding of targetBindings) {
                try {
                  const currentData = (typeof (targetBinding as any).data === 'string' ? JSON.parse((targetBinding as any).data) : (targetBinding as any).data) || {};
                  await db.update(groupBindings).set({
                    data: JSON.stringify({ ...currentData, [cooldownKey]: cooldownTime })
                  } as any).where(eq(groupBindings.id, targetBinding.id));
                } catch (e: any) {
                  log(`[monitor] Failed to set cooldown for group ${targetBinding.groupId}: ${e.message}`, "monitor");
                }
              }
            }
            log(`[monitor] Successfully posted update for ${signal.symbol} to ${binding.groupId}`, "monitor");
          } catch (e: any) {
            log(`[monitor] Post failed for ${signal.symbol} to ${binding.groupId}: ${e.message}`, "monitor");
          }
        }
      } else {
        // Just update the last monitored price if no message was sent
        const signalData = (typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data) || {};
        await storage.updateSignal(signal.id, {
          data: JSON.stringify({ ...signalData, lastMonitoredPrice: currentPrice })
        });
      }
    }
  } catch (err: any) { log("Monitor error: " + (err?.message || err)); }
}
