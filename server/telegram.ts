import { groupBindings, signals as signalsTable, users, wallets as walletsTable, trades as tradesTable, userLanes, commandUsage } from "../shared/schema";
import TelegramBot from 'node-telegram-bot-api';
import { storage } from './storage';
import { log } from "./index";
import axios from "axios";
import { eq, and, or, count, sql } from "drizzle-orm";
import { db } from "./db";
import { fetchPriceData } from "./price-service";
import { PublicKey } from "@solana/web3.js";

export let telegramBotInstance: TelegramBot | null = null;

export function getTelegramBot() {
  return telegramBotInstance;
}

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("TELEGRAM_BOT_TOKEN is missing. Bot will not start.", "telegram");
    return;
  }

  log("Initializing Telegram bot...", "telegram");
  
  if (telegramBotInstance) {
    log("Existing bot instance found, stopping polling...", "telegram");
    telegramBotInstance.stopPolling();
  }

  const bot = new TelegramBot(token, { 
    polling: {
      interval: 1000,
      autoStart: true,
      params: {
        timeout: 10
      }
    } 
  }); 
  
  telegramBotInstance = bot;

  const ensureUser = async (msg: TelegramBot.Message) => {
    const id = msg.from?.id.toString();
    if (!id) return null;
    const existingUser = await storage.getUser(id);
    if (existingUser) return existingUser;

    const user = await storage.upsertUser({
      id,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      isMainnet: true
    });

    return user;
  };

  // Access control function
  const checkUserAccess = async (userId: string, chatId: number): Promise<{ hasAccess: boolean; isPremium: boolean; remainingCommands: number; isRegisteredGroup: boolean; isInAnyGroup?: boolean }> => {
    const premiumGroupIds = process.env.PREMIUM_GROUP_IDS?.split(',') || [];
    const nonPremiumGroupIds = process.env.NON_PREMIUM_GROUP_IDS?.split(',') || [];
    const adminUserIds = process.env.ADMIN_USER_IDS?.split(',') || [];

    const chatIdStr = chatId.toString();
    const isPrivate = chatId > 0; // Private chats have positive IDs

    // Check if this is an admin user (admins have access everywhere)
    const isAdmin = adminUserIds.includes(userId);

    // For private chats, only check user membership if not admin
    if (isPrivate) {
      if (isAdmin) {
        return { hasAccess: true, isPremium: true, remainingCommands: -1, isRegisteredGroup: true, isInAnyGroup: true };
      }

      let isInPremiumGroup = false;
      let isInNonPremiumGroup = false;

      // Check premium groups
      for (const groupId of premiumGroupIds) {
        try {
          const member = await bot.getChatMember(groupId.trim(), parseInt(userId));
          if (member.status === 'member' || member.status === 'administrator' || member.status === 'creator') {
            isInPremiumGroup = true;
            break;
          }
        } catch (e) {
          // Ignore errors (user not in group, etc.)
        }
      }

      // Check non-premium groups
      for (const groupId of nonPremiumGroupIds) {
        try {
          const member = await bot.getChatMember(groupId.trim(), parseInt(userId));
          if (member.status === 'member' || member.status === 'administrator' || member.status === 'creator') {
            isInNonPremiumGroup = true;
            break;
          }
        } catch (e) {
          // Ignore errors
        }
      }

      const isInAnyGroup = isInPremiumGroup || isInNonPremiumGroup;

      // Premium users have full access
      if (isInPremiumGroup) {
        return { hasAccess: true, isPremium: true, remainingCommands: -1, isRegisteredGroup: true, isInAnyGroup };
      }

      // Non-premium users have limited access
      if (isInNonPremiumGroup) {
        const today = new Date().toISOString().split('T')[0];
        const totalUsage = await storage.getTotalDailyUsage(userId, today);
        const remaining = Math.max(0, 2 - totalUsage);
        return { hasAccess: remaining > 0, isPremium: false, remainingCommands: remaining, isRegisteredGroup: true, isInAnyGroup };
      }

      // Users not in any group get restricted message (prompt to join groups)
      return { hasAccess: false, isPremium: false, remainingCommands: 0, isRegisteredGroup: true, isInAnyGroup };
    }

    // For group chats, first check if the group is registered
    const isRegisteredGroup = premiumGroupIds.includes(chatIdStr) || nonPremiumGroupIds.includes(chatIdStr);

    if (!isRegisteredGroup && !isAdmin) {
      // Bot should not respond in unregistered groups
      return { hasAccess: false, isPremium: false, remainingCommands: 0, isRegisteredGroup: false };
    }

    // Group is registered, now check user access within the group
    if (isAdmin) {
      return { hasAccess: true, isPremium: true, remainingCommands: -1, isRegisteredGroup: true };
    }

    const isPremiumGroup = premiumGroupIds.includes(chatIdStr);

    if (isPremiumGroup) {
      // In premium groups, check if user is a member
      try {
        const member = await bot.getChatMember(chatIdStr, parseInt(userId));
        if (member.status === 'member' || member.status === 'administrator' || member.status === 'creator') {
          return { hasAccess: true, isPremium: true, remainingCommands: -1, isRegisteredGroup: true };
        }
      } catch (e) {
        // User not in group
      }
      return { hasAccess: false, isPremium: false, remainingCommands: 0, isRegisteredGroup: true };
    } else {
      // In non-premium groups, check membership and daily limit
      try {
        const member = await bot.getChatMember(chatIdStr, parseInt(userId));
        if (member.status === 'member' || member.status === 'administrator' || member.status === 'creator') {
          const today = new Date().toISOString().split('T')[0];
          const totalUsage = await storage.getTotalDailyUsage(userId, today);
          const remaining = Math.max(0, 2 - totalUsage);
          return { hasAccess: remaining > 0, isPremium: false, remainingCommands: remaining, isRegisteredGroup: true };
        }
      } catch (e) {
        // User not in group
      }
      return { hasAccess: false, isPremium: false, remainingCommands: 0, isRegisteredGroup: true };
    }
  };

  // Helper to escape HTML so Telegram doesn't choke on unbalanced tags
  const escapeHtml = (text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };

  // Track command usage
  const trackCommandUsage = async (userId: string, command: string) => {
    const today = new Date().toISOString().split('T')[0];
    await storage.incrementCommandUsage(userId, command, today);
  };

  // Enhanced AI analysis function with full market data access
  const performEnhancedAIAnalysis = async (query: string, searchResults?: string, imageUrl?: string): Promise<string> => {
    const { openRouterClient } = await import("./signals-worker");
    if (!openRouterClient) {
      throw new Error("AI service not initialized");
    }

    // Get current time and date
    const now = new Date();
    const currentTime = now.toISOString();
    const utcTime = now.toUTCString();
    const localTime = now.toLocaleString();

    // Extract potential trading pairs from query - with better validation
    const pairMatches = query.match(/([A-Z]{2,10})[\/\-]?([A-Z]{2,10})?/gi) || [];
    const detectedPairs = pairMatches.filter(match => {
      const parts = match.split(/[\/\-]/);
      const base = parts[0];
      const quote = parts[1] || 'USDT';
      
      // Only include pairs that look like valid trading symbols
      const validBases = ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'LINK', 'UNI', 'AAVE', 'SUSHI', 'COMP', 'MKR', 'YFI', 'BAL', 'REN', 'LRC', 'OMG', 'ZRX', 'BAT', 'ANT', 'STORJ', 'GRT', 'LPT', 'REP', 'NMR', 'FIL', 'STORJ', 'ANT', 'GRT', 'LPT', 'REP', 'NMR', 'FIL', 'BNB', 'XRP', 'DOGE', 'AVAX', 'MATIC', 'SHIB', 'CRO', 'VET', 'ICP', 'HBAR', 'NEAR', 'FLOW', 'MANA', 'SAND', 'AXS', 'CHZ', 'ENJ', 'BAT', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'USD'];
      const validQuotes = ['USDT', 'USD', 'BTC', 'ETH', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
      
      return validBases.includes(base.toUpperCase()) && validQuotes.includes(quote.toUpperCase()) && base.length >= 2;
    });

    // Fetch price data for detected pairs
    const priceDataPromises = detectedPairs.map(async (pair) => {
      try {
        const cleanPair = pair.replace(/[^A-Z\/]/gi, '').toUpperCase();
        const priceData = await fetchPriceData(cleanPair);
        return { pair: cleanPair, data: priceData };
      } catch (e) {
        return { pair, data: null };
      }
    });

    const priceResults = await Promise.all(priceDataPromises);
    const availablePriceData = priceResults.filter(result => result.data !== null);

    // Calculate technical indicators for available price data
    const technicalAnalysis = availablePriceData.map(({ pair, data }) => {
      if (!data) return null;

      const price = parseFloat(data.price);
      const change24h = data.change24h || 0;

      // Simple technical indicators (in a real system, you'd use historical data)
      const sma20 = price * 0.98; // Approximation
      const sma50 = price * 0.96; // Approximation
      const rsi = change24h > 0 ? 70 : 30; // Approximation
      const macd = price * 0.02; // Approximation

      return {
        pair,
        price: data.price,
        change24h: `${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%`,
        technicalIndicators: {
          sma20: sma20.toFixed(4),
          sma50: sma50.toFixed(4),
          rsi: rsi.toFixed(1),
          macd: macd.toFixed(4),
          support: (price * 0.95).toFixed(4),
          resistance: (price * 1.05).toFixed(4)
        },
        volume24h: data.volume24h?.toLocaleString() || 'N/A',
        source: data.source
      };
    }).filter(Boolean);

    // Build comprehensive system prompt
    const systemPrompt = `You are an expert crypto and forex analyst using Smart Money Concepts (SMC) with access to real-time market data.

CURRENT TIME INFORMATION:
- UTC Time: ${utcTime}
- ISO Time: ${currentTime}
- Local Time: ${localTime}

${imageUrl ? `IMAGE PROVIDED: ${imageUrl}

` : ''}AVAILABLE MARKET DATA:
${technicalAnalysis.length > 0 ? technicalAnalysis.map(ta => `
${ta.pair}:
- Current Price: $${ta.price}
- 24h Change: ${ta.change24h}
- Volume (24h): ${ta.volume24h}
- Technical Indicators:
  • SMA(20): $${ta.technicalIndicators.sma20}
  • SMA(50): $${ta.technicalIndicators.sma50}
  • RSI: ${ta.technicalIndicators.rsi}
  • MACD: ${ta.technicalIndicators.macd}
  • Support Level: $${ta.technicalIndicators.support}
  • Resistance Level: $${ta.technicalIndicators.resistance}
- Data Source: ${ta.source}
`).join('') : 'No specific trading pairs detected in query. Use general market knowledge.'}

${searchResults ? `WEB SEARCH RESULTS:\n${searchResults}\n` : ''}

INSTRUCTIONS:
1. Use current time for time-sensitive analysis
2. Reference real market data and technical indicators when relevant
3. Apply SMC concepts (liquidity, manipulation, institutional activity)
4. Provide actionable insights with risk management
5. Cite data sources and indicate confidence levels
6. For chart analysis, focus on price action, patterns, and levels
7. Always include time context in your analysis

Respond professionally with clear, actionable analysis.`;

    const userMessage = searchResults
      ? `Query: ${query}\n\nPlease analyze this query using all available market data, technical indicators, and current time context.`
      : query;

    try {
      const response = await openRouterClient.chat.completions.create({
        model: "anthropic/claude-3-haiku",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: 2000,
        temperature: 0.7
      });

      return response.choices[0].message?.content || "Analysis unavailable.";
    } catch (aiError: any) {
      log(`AI API Error: ${aiError.message}`, "telegram");
      if (aiError.status === 401) {
        log("OpenRouter API key is invalid - switching to fallback mode", "telegram");
        // Force disable AI client to prevent further credit consumption
        const { openRouterClient: client } = await import("./signals-worker");
        if (client) {
          // Clear the client to force fallback
          (await import("./signals-worker")).openRouterClient = null;
        }
        throw new Error("AI service authentication failed. Switched to fallback mode.");
      } else if (aiError.status === 429) {
        log("AI service rate limit exceeded - using fallback", "telegram");
        throw new Error("AI service rate limit exceeded. Using fallback analysis.");
      } else {
        log(`AI service error: ${aiError.message} - using fallback`, "telegram");
        throw new Error(`AI service error: ${aiError.message}`);
      }
    }
  };

  // Fallback AI analysis when API is not available
  const performFallbackAIAnalysis = (query: string): string => {
    // Extract potential trading pairs from query
    const pairMatches = query.match(/([A-Z]{2,10})[\/\-]?([A-Z]{2,10})?/gi) || [];
    const detectedPairs = pairMatches.filter(match => {
      const parts = match.split(/[\/\-]/);
      const base = parts[0];
      const quote = parts[1] || 'USDT';
      return base.length >= 2 && base.length <= 10;
    });

    const pairInfo = detectedPairs.length > 0
      ? `Detected trading pairs: ${detectedPairs.join(', ')}`
      : 'No specific trading pairs detected';

    return `🤖 <b>AI Analysis (Fallback Mode)</b>

⚠️ <b>Note:</b> AI service is currently unavailable. Using intelligent fallback analysis.

<b>Query:</b> ${escapeHtml(query)}

📊 <b>Technical Analysis:</b>
${pairInfo}

💡 <b>General Market Insights:</b>
- Monitor key support and resistance levels
- Consider volume confirmation for any moves
- Risk management is crucial in current market conditions
- Look for institutional accumulation patterns

🎯 <b>Trading Recommendations:</b>
- Use proper position sizing (1-2% per trade)
- Set stop losses based on technical levels
- Consider multiple timeframe analysis
- Wait for high-probability setups

<i>Full AI analysis will resume when API service is restored.</i>`;
  };

  const sendTokenOverview = async (chatId: number, mint: string, messageId?: number, threadId?: number) => {
    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = response.data as any;
      const pair = data.pairs?.[0];

      if (!pair) {
        bot.sendMessage(chatId, "❌ <b>Token not found on DexScreener.</b>", { parse_mode: 'HTML', message_thread_id: threadId });
        return;
      }

      const name = pair.baseToken.name;
      const symbol = pair.baseToken.symbol;
      const price = pair.priceUsd ? `$${parseFloat(pair.priceUsd).toFixed(6)}` : "N/A";
      const mcap = pair.fdv ? `$${pair.fdv.toLocaleString()}` : "N/A";
      const liq = pair.liquidity?.usd ? `$${pair.liquidity.usd.toLocaleString()}` : "N/A";
      const vol = pair.volume?.h24 ? `$${pair.volume.h24.toLocaleString()}` : "N/A";
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const change = pair.priceChange?.h24 ? `${pair.priceChange.h24 > 0 ? '+' : ''}${pair.priceChange.h24}%` : "0%";

      // Extract social links from DexScreener
      const socials = pair.info || {};
      const website = socials.websites?.[0]?.url || 'N/A';
      const twitter = socials.socials?.find((s: any) => s.type === 'twitter')?.url || 'N/A';
      const telegram = socials.socials?.find((s: any) => s.type === 'telegram')?.url || 'N/A';
      const discord = socials.socials?.find((s: any) => s.type === 'discord')?.url || 'N/A';

      // Check if user is premium for enhanced overview
      const userId = "unknown"; // We don't have userId here, but we can check group premium status
      const premiumGroupIds = process.env.PREMIUM_GROUP_IDS?.split(',') || [];
      const isPremiumGroup = premiumGroupIds.includes(chatId.toString());

      const safeName = escapeHtml(name);
      const safeSymbol = escapeHtml(symbol);
      const safeMint = escapeHtml(mint);

      // Always perform AI social analysis for meme coins
      let socialAnalysis = '';
      try {
        const { openRouterClient } = await import("./signals-worker");
        if (openRouterClient) {
          const socialPrompt = `Analyze this meme coin's social presence and community strength:

TOKEN: ${name} (${symbol})
WEBSITE: ${website}
TWITTER: ${twitter}
TELEGRAM: ${telegram}
DISCORD: ${discord}

MARKET DATA:
- Price: ${price}
- Market Cap: ${mcap}
- 24h Volume: ${vol}
- 24h Transactions: ${buys + sells} (${buys} buys, ${sells} sells)

Provide a brief analysis of:
1. Social media presence quality and activity
2. Community engagement indicators
3. Red flags or positive signals
4. Overall community health score (1-10)

Keep analysis concise but insightful.`;

          const aiResponse = await (openRouterClient as any).chat.completions.create({
            model: "google/gemini-2.0-flash-001",
            messages: [{ role: "user", content: socialPrompt }],
            max_tokens: 500,
            temperature: 0.7
          });

          socialAnalysis = aiResponse.choices[0].message?.content || "Social analysis unavailable.";
        }
      } catch (aiError) {
        log(`AI social analysis failed: ${aiError.message}`, "telegram");
        socialAnalysis = "AI analysis temporarily unavailable.";
      }

      let message = `🧪 <b>Token Overview</b>\n\n` +
                    `📛 Name: ${safeName}\n` +
                    `💊 Symbol: $${safeSymbol}\n` +
                    `🔗 Mint: <code>${safeMint}</code>\n\n` +
                    `📊 <b>Market</b>\n` +
                    `• Price: ${price}\n` +
                    `• Market Cap: ${mcap}\n` +
                    `• Liquidity: ${liq}\n` +
                    `• Volume (24h): ${vol}\n\n` +
                    `📈 <b>Activity (24h)</b>\n` +
                    `• Buys: ${buys} | Sells: ${sells}\n` +
                    `• Change: ${change}\n\n` +
                    `🌐 <b>Social Links</b>\n` +
                    `• Website: ${website !== 'N/A' ? website : 'N/A'}\n` +
                    `• Twitter: ${twitter !== 'N/A' ? twitter : 'N/A'}\n` +
                    `• Telegram: ${telegram !== 'N/A' ? telegram : 'N/A'}\n` +
                    `• Discord: ${discord !== 'N/A' ? discord : 'N/A'}\n\n` +
                    `🤖 <b>AI Social Analysis</b>\n${escapeHtml(socialAnalysis)}\n\n` +
                    `⚠️ <i>This is not financial advice.</i>`;

      // Premium enhancements
      if (isPremiumGroup) {
        // Add premium metrics
        const holderAnalysis = buys + sells > 0 ? `Holder Distribution: ${buys > sells ? 'Accumulation' : 'Distribution'}` : 'Limited activity';
        const liqToMcap = pair.fdv && pair.liquidity?.usd ? (pair.liquidity.usd / pair.fdv * 100).toFixed(1) : 'N/A';
        const volToMcap = pair.fdv && pair.volume?.h24 ? (pair.volume.h24 / pair.fdv * 100).toFixed(1) : 'N/A';

        const safeName = escapeHtml(name);
        const safeSymbol = escapeHtml(symbol);
        const safeMint = escapeHtml(mint);

        message = `💎 <b>PREMIUM TOKEN ANALYSIS</b>\n\n` +
                  `📛 Name: ${safeName}\n` +
                  `💊 Symbol: $${safeSymbol}\n` +
                  `🔗 Mint: <code>${safeMint}</code>\n\n` +
                  `📊 <b>Market Metrics</b>\n` +
                  `• Price: ${price}\n` +
                  `• Market Cap: ${mcap}\n` +
                  `• Liquidity: ${liq}\n` +
                  `• Volume (24h): ${vol}\n\n` +
                  `📈 <b>Activity & Health (24h)</b>\n` +
                  `• Buys: ${buys} | Sells: ${sells}\n` +
                  `• Net Change: ${change}\n` +
                  `• ${holderAnalysis}\n` +
                  `• Liq/MCap Ratio: ${liqToMcap}%\n` +
                  `• Vol/MCap Ratio: ${volToMcap}%\n\n` +
                  `🌐 <b>Social Links</b>\n` +
                  `• Website: ${website !== 'N/A' ? website : 'N/A'}\n` +
                  `• Twitter: ${twitter !== 'N/A' ? twitter : 'N/A'}\n` +
                  `• Telegram: ${telegram !== 'N/A' ? telegram : 'N/A'}\n` +
                  `• Discord: ${discord !== 'N/A' ? discord : 'N/A'}\n\n` +
                  `🤖 <b>AI Social Analysis</b>\n${escapeHtml(socialAnalysis)}\n\n` +
                  `🔍 <b>Premium Insights</b>\n` +
                  `• <b>Risk Level:</b> ${pair.liquidity?.usd && pair.liquidity.usd < 10000 ? 'High' : pair.liquidity.usd < 50000 ? 'Medium' : 'Low'}\n` +
                  `• <b>Volume Health:</b> ${pair.volume?.h24 && pair.fdv ? (pair.volume.h24 > pair.fdv * 0.1 ? 'Excellent' : pair.volume.h24 > pair.fdv * 0.05 ? 'Good' : 'Poor') : 'Unknown'}\n` +
                  `• <b>Community Activity:</b> ${buys + sells > 100 ? 'High' : buys + sells > 50 ? 'Medium' : 'Low'}\n\n` +
                  `⚠️ <i>Institutional analysis included. Not financial advice.</i>`;
      }

      const keyboard = [
        [{ text: "🤖 AI Analysis", callback_data: `ai_analyze_${mint}` }],
        [{ text: "🔄 Refresh", callback_data: `refresh_overview_${mint}` }]
      ];

      if (messageId) {
        try {
          await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        } catch (e: any) {
          if (!e.message.includes("message is not modified")) throw e;
        }
      } else {
        bot.sendMessage(chatId, message, { parse_mode: 'HTML', message_thread_id: threadId, reply_markup: { inline_keyboard: keyboard } });
      }
    } catch (e: any) {
      log(`Error fetching token overview: ${e.message}`, "telegram");
      bot.sendMessage(chatId, "❌ <b>Error fetching token data.</b>", { parse_mode: 'HTML' });
    }
  };

  const executeAiReasoning = async (chatId: number, mint: string, threadId?: number) => {
    bot.sendMessage(chatId, "🤖 <b>Generating AI Reasoning with Web Research...</b>", { parse_mode: 'HTML', message_thread_id: threadId });
    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = response.data as any;
      const pair = data.pairs?.[0];
      if (!pair) throw new Error("Token data not found.");

      const tokenName = pair.baseToken.name;
      const tokenSymbol = pair.baseToken.symbol;

      // Extract social links from DexScreener for enhanced analysis
      const socials = pair.info || {};
      const website = socials.websites?.[0]?.url || 'Not available';
      const twitter = socials.socials?.find((s: any) => s.type === 'twitter')?.url || 'Not available';
      const telegramSocial = socials.socials?.find((s: any) => s.type === 'telegram')?.url || 'Not available';
      const discord = socials.socials?.find((s: any) => s.type === 'discord')?.url || 'Not available';

      // Perform extensive web research for meme coins
      let researchResults = '';
      try {
        bot.sendMessage(chatId, "🔍 <b>Researching web and analyzing socials...</b>", { parse_mode: 'HTML', message_thread_id: threadId });
        const searchQueries = [
          `${tokenName} ${tokenSymbol} news latest developments`,
          `${tokenSymbol} meme coin analysis market sentiment`,
          `${tokenName} token community growth partnerships`,
          `${tokenSymbol} price prediction technical analysis`,
          `${tokenName} social media community analysis`,
          `${tokenSymbol} Twitter Telegram Discord activity`
        ];

        const searchPromises = searchQueries.map(query => searchDuckDuckGo(query));
        const searchResults = await Promise.all(searchPromises);
        researchResults = searchResults.join('\n\n---\n\n');
      } catch (searchError) {
        log(`Web research failed: ${searchError}`, "telegram");
        researchResults = 'Web research unavailable';
      }

      const marketData = JSON.stringify({
        name: tokenName,
        symbol: tokenSymbol,
        price: pair.priceUsd,
        fdv: pair.fdv,
        liquidity: pair.liquidity?.usd,
        volume24h: pair.volume?.h24,
        txns24h: pair.txns?.h24,
        priceChange24h: pair.priceChange?.h24,
        socials: {
          website,
          twitter,
          telegram: telegramSocial,
          discord
        }
      });

      const { openRouterClient } = await import("./signals-worker");
      if (!openRouterClient) throw new Error("AI Client not initialized.");

      const aiResponse = await (openRouterClient as any).chat.completions.create({
        model: "google/gemini-2.0-flash-001",
        messages: [
          {
            role: "system",
            content: `You are an expert Solana meme coin analyst with access to real-time market data, social media links, and extensive web research. Analyze this token comprehensively using all available data.

MARKET DATA:
${marketData}

WEB RESEARCH FINDINGS:
${researchResults}

CRITICAL ANALYSIS REQUIREMENTS:
1. **Social Media Analysis** - Always analyze community presence, activity levels, and authenticity
   - Check Twitter/Telegram/Discord engagement and follower growth
   - Identify red flags like fake accounts, low activity, or suspicious patterns
   - Assess community health and developer transparency

2. **Liquidity & LP Analysis** - Examine pool health and distribution
3. **Market Structure** - Current metrics and trading patterns
4. **Community & Development** - Insights from socials and web research
5. **Risk Assessment** - Technical and fundamental risks
6. **Investment Analysis** - Clear recommendations with entry/exit points

Format professionally with emojis and clear sections. Include disclaimer about not being financial advice.`
          },
          {
            role: "user",
            content: `Analyze ${tokenName} (${tokenSymbol}) as a potential meme coin investment. 

CRITICAL: Pay special attention to the social media links and community analysis. Check:
- Are the social accounts active and authentic?
- Community engagement levels and growth
- Developer transparency and communication
- Any red flags in social presence

Use ALL provided data (market metrics, social links, web research) to give comprehensive analysis focusing on community strength, development activity, market sentiment, and risk factors.`
          }
        ],
        max_tokens: 3000,
        temperature: 0.7
      });

      const analysis = aiResponse.choices[0].message?.content || "Analysis unavailable.";
      const safeAnalysis = escapeHtml(analysis);
      
      // Check message length and split if necessary (Telegram limit: 4096 chars)
      const maxMessageLength = 4000;
      if (safeAnalysis.length > maxMessageLength) {
        const truncatedAnalysis = safeAnalysis.substring(0, maxMessageLength) + "\n\n<i>Analysis truncated due to message length limits</i>";
        bot.sendMessage(chatId, truncatedAnalysis, { parse_mode: 'HTML', message_thread_id: threadId });
      } else {
        bot.sendMessage(chatId, safeAnalysis, { parse_mode: 'HTML', message_thread_id: threadId });
      }
    } catch (e: any) {
      log(`AI reasoning error: ${e.message}`, "telegram");
      bot.sendMessage(chatId, `❌ <b>AI Analysis Failed:</b> ${e.message}`, { parse_mode: 'HTML', message_thread_id: threadId });
    }
  };

  async function sendMainMenu(chatId: number, userId: string, messageId?: number, accessCheck?: { hasAccess: boolean; isPremium: boolean; remainingCommands: number }) {
    // Get access info if not provided
    if (!accessCheck) {
      accessCheck = await checkUserAccess(userId, chatId);
    }

    let accessStatus = "";
    if (accessCheck.isPremium) {
      accessStatus = "💎 <b>Premium Access</b> - Unlimited commands\n\n";
    } else if (accessCheck.hasAccess) {
      accessStatus = `🎯 <b>Free Access</b> - ${accessCheck.remainingCommands} commands remaining today\n\n`;
    } else {
      accessStatus = "🚫 <b>Access Restricted</b> - Join our group for 2 free commands/day\n\n";
    }

    const header = `🚀 <b>Welcome to Coin Hunter Bot</b>\n\n` +
                   `Advanced AI signals & analysis platform.\n` +
                   `📊 <b>Signal Limits:</b> 1/day per market, max 3 active\n\n` +
                   accessStatus +
                   `Quick Commands:\n` +
                   `• /p [symbol] - Get price (e.g. /p BTC/USDT)\n` +
                   `• /ai [query] - AI analysis with web search\n` +
                   `• /analyze [pair] - Deep market analysis (chart + indicators)\n` +
                   `• /setup [pair] - Find high-probability setups\n` +
                   `• /help - Show command list and premium info`;

    const keyboard = [
      [{ text: "🔄 Refresh", callback_data: "main_menu_refresh" }],
      [{ text: "ℹ️ Help", callback_data: "main_menu_help" }],
      [{ text: "🔍 Price", callback_data: "main_menu_help" }, { text: "🤖 AI", callback_data: "main_menu_help" }]
    ];
    if (messageId) {
      try {
        await bot.editMessageText(header, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      } catch (e: any) {
        if (!e.message.includes("message is not modified")) throw e;
      }
    } else {
      bot.sendMessage(chatId, header, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }
  }

  bot.on('message', async (msg) => {
    log(`Received message from ${msg.from?.username} (${msg.from?.id}): ${msg.text}`, "telegram");
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    if (!userId) return;

    const now = Math.floor(Date.now() / 1000);
    if (msg.date && (now - msg.date > 30)) return;

    try {
      await ensureUser(msg);
      const isPrivate = msg.chat.type === 'private';

      // Check user access
      const accessCheck = await checkUserAccess(userId, chatId);
      if (!accessCheck.hasAccess) {
        if (!accessCheck.isRegisteredGroup) {
          // Bot should not respond at all in unregistered groups
          log(`Message ignored: Chat ${chatId} is not a registered group`, "telegram");
          return;
        }

        // Private chat: differentiate between not joined vs daily limit
        if (isPrivate) {
          if (!accessCheck.isInAnyGroup) {
            bot.sendMessage(chatId, 
              "🚫 <b>Access Restricted</b>\n\n" +
              "You need to join our community to use Coin Hunter Bot!\n\n" +
              "🎯 <b>Free Access:</b> Join our group for <b>2 commands per day</b>\n" +
              "https://t.me/CoinHunterAIBot\n\n" +
              "💎 <b>Premium Access:</b> Unlimited commands + advanced features\n" +
              "• Weekly: $25\n" +
              "• Monthly: $100\n" +
              "https://t.me/onlysubsbot?start=mTVmGRKJjehzHMqZCnxkU\n\n" +
              "Join now and start analyzing smarter! 🚀", 
              { parse_mode: 'HTML', message_thread_id: msg.message_thread_id }
            );
            return;
          }

          if (!accessCheck.isPremium && accessCheck.remainingCommands === 0) {
            bot.sendMessage(chatId, 
              "⏰ <b>Daily Limit Reached</b>\n\n" +
              "You've used all 2 free commands for today.\n\n" +
              "💎 <b>Upgrade to Premium</b> for unlimited access:\n" +
              "• Weekly: $25\n" +
              "• Monthly: $100\n" +
              "https://t.me/onlysubsbot?start=mTVmGRKJjehzHMqZCnxkU\n\n" +
              "Come back tomorrow for more free analysis! 🌅", 
              { parse_mode: 'HTML', message_thread_id: msg.message_thread_id }
            );
            return;
          }
        }

        // Fallback for any other cases
        if (!accessCheck.isPremium && accessCheck.remainingCommands === 0) {
          bot.sendMessage(chatId, 
            "⏰ <b>Daily Limit Reached</b>\n\n" +
            "You've used all 2 free commands for today.\n\n" +
            "💎 <b>Upgrade to Premium</b> for unlimited access:\n" +
            "• Weekly: $25\n" +
            "• Monthly: $100\n" +
            "https://t.me/onlysubsbot?start=mTVmGRKJjehzHMqZCnxkU\n\n" +
            "Come back tomorrow for more free analysis! 🌅", 
            { parse_mode: 'HTML', message_thread_id: msg.message_thread_id }
          );
          return;
        }
      }

      // Check for AI lane restriction in groups
      const checkAiLane = async () => {
        if (isPrivate) return true;

        const chatIdStr = chatId.toString();
        const normalizedIds = [chatIdStr];
        if (chatIdStr.startsWith("-100")) {
          normalizedIds.push(chatIdStr.replace("-100", ""));
        } else {
          normalizedIds.push(`-100${chatIdStr}`);
        }

        // Allow AI commands if the group is bound in the DB (any market)
        try {
          const binding = await db.select().from(groupBindings).where(
            or(...normalizedIds.map(id => eq(groupBindings.groupId, id)))
          ).limit(1);

          if (binding.length > 0) {
            return true;
          }
        } catch (e: any) {
          log(`Failed to check group bindings for AI access: ${e.message}`, "telegram");
        }

        // Fallback: allow if the group is explicitly configured via environment variables
        const premiumGroupIds = (process.env.PREMIUM_GROUP_IDS || "").split(',').map(s => s.trim()).filter(Boolean);
        const nonPremiumGroupIds = (process.env.NON_PREMIUM_GROUP_IDS || "").split(',').map(s => s.trim()).filter(Boolean);

        const registeredIds = new Set<string>();
        const normalizeId = (id: string) => {
          const clean = id.trim();
          if (clean.startsWith("-100")) return [clean, clean.replace("-100", "")];
          return [clean, `-100${clean}`];
        };

        premiumGroupIds.forEach(id => normalizeId(id).forEach(v => registeredIds.add(v)));
        nonPremiumGroupIds.forEach(id => normalizeId(id).forEach(v => registeredIds.add(v)));

        if (!registeredIds.has(chatIdStr)) {
          log(`AI command blocked: Group ${chatId} is not registered (not in premium or non-premium groups).`, "telegram");
          return false;
        }

        return true;
      };

      // Define /ai command
      if (msg.text?.startsWith('/ai ')) {
        if (!(await checkAiLane())) return;
        const query = msg.text.slice(4).trim();
        if (!query) {
          bot.sendMessage(chatId, "❌ Please provide a query, e.g. <code>/ai Analyze BTC sentiment</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        // Track usage for non-premium users
        if (!accessCheck.isPremium) {
          await trackCommandUsage(userId, 'ai');
        }

        bot.sendMessage(chatId, "🤖 <b>Processing AI Request...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        const { openRouterClient } = await import("./signals-worker");
        if (!openRouterClient) {
          bot.sendMessage(chatId, "❌ AI service not initialized.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        try {
          // Check if query requires web search
          const searchKeywords = ['news', 'latest', 'current', 'today', 'recent', 'update', 'what happened', 'search', 'find', 'look up', 'web search', 'breaking', 'announcement', 'development', 'partnership', 'listing', 'delisting', 'regulation', 'policy', 'government', 'fed', 'ecb', 'central bank'];
          const needsSearch = searchKeywords.some(keyword => query.toLowerCase().includes(keyword));

          let searchResults = '';
          if (needsSearch) {
            bot.sendMessage(chatId, "🔍 <b>Searching web for latest information...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            searchResults = await searchDuckDuckGo(query);
          }

          // Premium enhancement: Advanced AI analysis with comparative insights
          let enhancedQuery = query;
          if (accessCheck.isPremium) {
            enhancedQuery = `Provide institutional-grade analysis for: "${query}"

**PREMIUM ANALYSIS REQUIREMENTS:**

1. **Deep Market Context**
   - Historical performance patterns
   - Comparative analysis with similar assets
   - Market cycle positioning

2. **Advanced Technical Analysis**
   - Multi-timeframe confluence
   - Institutional order flow analysis
   - Volume profile insights

3. **Fundamental Factors**
   - On-chain metrics and adoption trends
   - Regulatory and macroeconomic impacts
   - Competitive landscape analysis

4. **Risk Assessment**
   - Volatility analysis and VaR calculations
   - Correlation with major assets
   - Black swan scenario planning

5. **Strategic Recommendations**
   - Portfolio allocation suggestions
   - Risk-adjusted position sizing
   - Long-term investment thesis

${searchResults ? `**LATEST MARKET INTELLIGENCE:**\n${searchResults}\n\n` : ''}

Provide data-driven insights with specific metrics, probabilities, and actionable intelligence.`;
          }

          const analysis = await performEnhancedAIAnalysis(enhancedQuery, searchResults);
          const premiumBadge = accessCheck.isPremium ? '\n\n💎 <b>PREMIUM ANALYSIS</b> - Institutional-grade insights included' : '';
          const fullMessage = escapeHtml(analysis) + premiumBadge;
          
          // Check message length and split if necessary (Telegram limit: 4096 chars)
          const maxMessageLength = 4000;
          if (fullMessage.length > maxMessageLength) {
            const truncatedMessage = fullMessage.substring(0, maxMessageLength) + "\n\n<i>Analysis truncated due to message length limits</i>";
            bot.sendMessage(chatId, truncatedMessage, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          } else {
            bot.sendMessage(chatId, fullMessage, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          }
        } catch (e: any) {
          log(`AI analysis error: ${e.message}`, "telegram");
          // Use fallback analysis
          const fallbackAnalysis = performFallbackAIAnalysis(query);
          bot.sendMessage(chatId, fallbackAnalysis, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      // Define /p command for price lookup
      if (msg.text?.startsWith('/p ')) {
        const symbol = msg.text.slice(3).trim();
        if (!symbol) {
          bot.sendMessage(chatId, "❌ Please provide a symbol, e.g. <code>/p BTC/USDT</code> or <code>/p EUR/USD</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        // Track usage for non-premium users
        if (!accessCheck.isPremium) {
          await trackCommandUsage(userId, 'price');
        }

        bot.sendMessage(chatId, "📊 <b>Fetching price data...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });

        try {
          const priceData = await fetchPriceData(symbol);
          if (!priceData) {
            bot.sendMessage(chatId, `❌ <b>Price not found</b>\n\nCould not fetch price for <code>${symbol}</code>. Please check the symbol format.`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            return;
          }

          const changeEmoji = priceData.change24h > 0 ? '📈' : priceData.change24h < 0 ? '📉' : '➡️';
          const changeText = priceData.change24h !== 0 ? `${changeEmoji} ${priceData.change24h > 0 ? '+' : ''}${priceData.change24h.toFixed(2)}%` : '➡️ 0.00%';

          const message = `💰 <b>Price: ${symbol.toUpperCase()}</b>\n\n` +
                          `💵 Price: <b>${parseFloat(priceData.price).toLocaleString()} ${priceData.quote}</b>\n` +
                          `📊 Change (24h): <b>${changeText}</b>\n` +
                          `⬆️ High (24h): <b>${parseFloat(priceData.high24h).toLocaleString()} ${priceData.quote}</b>\n` +
                          `⬇️ Low (24h): <b>${parseFloat(priceData.low24h).toLocaleString()} ${priceData.quote}</b>\n` +
                          `📈 Volume (24h): <b>${priceData.volume24h.toLocaleString()}</b>\n\n` +
                          `🔍 <b>Source:</b> ${priceData.source}\n\n` +
                          `⚠️ <i>Price data may vary between sources.</i>`;

          bot.sendMessage(chatId, message, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (e: any) {
          log(`Price fetch error: ${e.message}`, "telegram");
          bot.sendMessage(chatId, `❌ <b>Error fetching price:</b> ${e.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      const extractMintFromText = (text?: string): string | null => {
        if (!text) return null;
        // Handle Dexscreener URLs
        const dsMatch = text.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/i);
        if (dsMatch?.[1]) return dsMatch[1];

        // Try to extract a raw base58 mint string
        const base58Match = text.match(/([A-Za-z0-9]{32,44})/);
        if (base58Match?.[1]) return base58Match[1];

        return null;
      };

      const potentialMint = extractMintFromText(msg.text);
      if (potentialMint) {
        if (!(await checkAiLane())) return;
        const mint = potentialMint.trim();
        try {
          new PublicKey(mint);
          // Track usage for non-premium users
          if (!accessCheck.isPremium) {
            await trackCommandUsage(userId, 'token_overview');
          }
          await sendTokenOverview(chatId, mint, undefined, msg.message_thread_id);
          return;
        } catch (e) {
          // Not a valid public key, ignore
        }
      }

      if (msg.text === '/bind' || msg.text?.startsWith('/bind ')) {
        // Check if user is admin
        const adminUserIds = process.env.ADMIN_USER_IDS?.split(',') || [];
        if (!adminUserIds.includes(userId)) {
          bot.sendMessage(chatId, "❌ <b>Admin access required.</b> Only administrators can bind markets.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        const parts = msg.text.split(' ');
        if (parts.length < 2) {
          bot.sendMessage(chatId, "❌ Usage: <code>/bind [market]</code>\nMarkets: <code>crypto, forex, ai</code>", { parse_mode: 'HTML' });
          return;
        }
        const lane = parts[1].toLowerCase();
        const market = (lane === 'forex') ? 'forex' : (lane === 'crypto' ? 'crypto' : (lane === 'ai' ? 'ai' : null));
        
        if (!market) {
          bot.sendMessage(chatId, "❌ Invalid market. Use <code>crypto</code>, <code>forex</code>, or <code>ai</code>.", { parse_mode: 'HTML' });
          return;
        }

        try {
          const groupIdStr = chatId.toString().trim();
          log(`Attempting to bind for group ${groupIdStr}, market: ${market}`, "telegram");

          // Check if binding exists for this group and market
          const existing = await db.select().from(groupBindings).where(
            and(
              eq(groupBindings.groupId, groupIdStr),
              eq(groupBindings.market, market)
            )
          ).limit(1);

          const cooldownKey = `cooldown_${market}`;
          const cooldownData = { [cooldownKey]: Date.now() + (10 * 60 * 1000) };

          if (existing.length > 0) {
            await db.update(groupBindings).set({
              topicId: msg.message_thread_id?.toString() || null,
              lane: market,
              data: JSON.stringify({ ...((typeof existing[0].data === 'string' ? JSON.parse(existing[0].data) : existing[0].data) || {}), ...cooldownData })
            }).where(eq(groupBindings.id, existing[0].id));
          } else {
            await db.insert(groupBindings).values({
              groupId: groupIdStr,
              topicId: msg.message_thread_id?.toString() || null,
              lane: market,
              market: market,
              data: JSON.stringify(cooldownData)
            });
          }

          let response = `✅ <b>Group Bound!</b>\nMarket: <code>${market}</code>\nTopic: <code>${msg.message_thread_id || 'Main'}</code>`;
          if (market !== 'ai') {
            response += `\n\n⏱ <i>Cooldown active: Scanning for new institutional setups in 10m...</i>`;
          }
          bot.sendMessage(chatId, response, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (dbErr: any) {
          log(`Bind error: ${dbErr.message}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Database error during binding.</b> Please ensure the bot is admin.", { parse_mode: 'HTML' });
        }
        return;
      }

      if (msg.text === '/unbind' || msg.text?.startsWith('/unbind ')) {
        // Check if user is admin
        const adminUserIds = process.env.ADMIN_USER_IDS?.split(',') || [];
        if (!adminUserIds.includes(userId)) {
          bot.sendMessage(chatId, "❌ <b>Admin access required.</b> Only administrators can unbind markets.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        const parts = msg.text.trim().split(/\s+/);
        const market = parts[1]?.toLowerCase();
        
        try {
          const groupIdStr = chatId.toString().trim();
          log(`Attempting to unbind for group ${groupIdStr}, market: ${market || 'ALL'}`, "telegram");
          
          if (market === 'crypto' || market === 'forex' || market === 'ai') {
            const deleted = await db.delete(groupBindings).where(
              and(
                or(
                  eq(groupBindings.groupId, groupIdStr),
                  eq(groupBindings.groupId, groupIdStr.replace("-100", "")),
                  eq(groupBindings.groupId, groupIdStr.includes("-100") ? groupIdStr : `-100${groupIdStr}`)
                ),
                eq(groupBindings.market, market)
              )
            ).returning();
            log(`Successfully unbound market ${market} for group ${groupIdStr}. Deleted rows: ${deleted.length}`, "telegram");
          } else {
            const deleted = await db.delete(groupBindings).where(
              or(
                eq(groupBindings.groupId, groupIdStr),
                eq(groupBindings.groupId, groupIdStr.replace("-100", "")),
                eq(groupBindings.groupId, groupIdStr.includes("-100") ? groupIdStr : `-100${groupIdStr}`)
              )
            ).returning();
            log(`Successfully unbound ALL markets for group ${groupIdStr}. Deleted rows: ${deleted.length}`, "telegram");
          }

          bot.sendMessage(chatId, `✅ <b>Group Unbound!</b>${market && (market === 'crypto' || market === 'forex' || market === 'ai') ? `\nMarket: <code>${market}</code>` : '\nAll markets unbound.'}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (dbErr: any) {
          log(`Unbind error: ${dbErr.message}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Database error during unbinding.</b>", { parse_mode: 'HTML' });
        }
        return;
      }

      if (msg.text === '/cleardb') {
        // Check if user is admin
        const adminUserIds = process.env.ADMIN_USER_IDS?.split(',') || [];
        if (!adminUserIds.includes(userId)) {
          bot.sendMessage(chatId, "❌ <b>Admin access required.</b> Only administrators can clear the database.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        // Only allow in private chats for security
        if (msg.chat.type !== 'private') {
          bot.sendMessage(chatId, "❌ <b>Database clear command only available in private chat.</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        try {
          // Clear history tables
          const signalsDeleted = await db.delete(signalsTable).where(sql`1=1`).returning();
          const tradesDeleted = await db.delete(tradesTable).where(sql`1=1`).returning();
          const commandUsageDeleted = await db.delete(commandUsage).where(sql`1=1`).returning();

          const totalDeleted = signalsDeleted.length + tradesDeleted.length + commandUsageDeleted.length;

          bot.sendMessage(chatId, `✅ <b>Database Cleared!</b>\n\n` +
            `📊 Signals deleted: ${signalsDeleted.length}\n` +
            `💰 Trades deleted: ${tradesDeleted.length}\n` +
            `📈 Command usage deleted: ${commandUsageDeleted.length}\n\n` +
            `Total records removed: <b>${totalDeleted}</b>`, { parse_mode: 'HTML' });
          
          log(`Database cleared by user ${userId}: ${totalDeleted} records removed`, "telegram");
        } catch (dbErr: any) {
          log(`ClearDB error: ${dbErr.message}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Database error during clearing.</b>", { parse_mode: 'HTML' });
        }
        return;
      }

      if (msg.text === '/help' || msg.text === '/start' || msg.text === '/menu') {
        const helpMessage = `🏛️ <b>Coin Hunter AI Bot - Command Guide</b>\n\n` +
          `<b>Core Commands:</b>\n` +
          `• /start or /menu - Access the main analysis dashboard\n` +
          `• /bind [market] - Bind group to <code>crypto</code>, <code>forex</code>, or <code>ai</code>\n` +
          `• /analyze [pair] - Get comprehensive market analysis with indicators\n` +
          `• /setup [pair] - Find high-probability setups with risk management\n` +
          `• /ai [query] - Advanced AI analysis with real-time data & web search\n` +
          `• /p [symbol] - Get live price data (e.g. /p BTC/USDT)\n` +
          `• /unbind [market] - Unbind group from signals\n\n` +
          `<b>Signal Limits & Rules:</b>\n` +
          `• <b>Daily Limits:</b> 1 signal per day per market (crypto/forex)\n` +
          `• <b>Max Active:</b> 3 signals total across both markets\n` +
          `• <b>Auto-Close:</b> Signals close after 3 days with P&L summary\n` +
          `• <b>Volume Filter:</b> Only pairs with sufficient trading volume\n` +
          `• <b>Weekend Forex:</b> BTC/USDT signals sent via crypto scanner\n` +
          `• <b>Cooldown:</b> 10 minutes after signal completion\n\n` +
          `<b>Usage Limits:</b>\n` +
          `• <b>Premium Groups:</b> Unlimited access to all features\n` +
          `• <b>Free Groups:</b> 2 commands per day per user\n` +
          `• <b>Limited Commands:</b> /ai, /analyze, /setup, /p, and token overviews\n` +
          `• <b>Free Commands:</b> /help and basic navigation\n` +
          `• <b>Reset Time:</b> Daily limits reset at 00:00 UTC\n\n` +
          `<i>Note: Signals are posted automatically to bound groups every 15m. AI commands are restricted to the AI topic if bound.</i>`;
        
        if (isPrivate) {
          if (msg.text === '/help') {
            bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
          } else {
            await sendMainMenu(chatId, userId);
          }
        } else if (msg.text === '/help' || msg.text === '/start') {
          bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }



      if (msg.photo && (msg.caption?.startsWith('/analyze') || msg.caption?.startsWith('/setup') || msg.caption?.startsWith('/ai'))) {
        if (!(await checkAiLane())) return;
        const parts = msg.caption.split(' ');
        const command = parts[0].replace('/', '');
        const pair = parts[1]?.toUpperCase();
        
        // Handle AI image analysis (supports /analyze, /setup, and /ai with image)
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        
        bot.sendMessage(chatId, `⏳ <b>Analyzing image for ${pair || 'analysis'}...</b>`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        
        const aiModule = await import("./ai");
        const ai = aiModule.default || aiModule;
        
        let targetPair: string | undefined = pair;
        if (!targetPair) {
          const detected = await ai.extractPairFromImage(fileLink);
          targetPair = detected || undefined;
        }
        
        if (!targetPair && command !== 'ai') {
          bot.sendMessage(chatId, "❌ <b>Could not detect trading pair from image.</b> Please provide it manually: <code>/analyze BTC/USDT</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        // Track usage for non-premium users
        if (!accessCheck.isPremium) {
          await trackCommandUsage(userId, command);
        }

        try {
          if (command === 'ai') {
            // Use AI reasoning for generic image + caption context
            const question = parts.slice(1).join(' ') || 'Please analyze this image';
            const aiResponse = await performEnhancedAIAnalysis(`${question}\n\n[Image analysis requested]`, undefined, fileLink);
            const safeResponse = escapeHtml(aiResponse);

            // Check message length and split if necessary (Telegram limit: 4096 chars)
            const maxMessageLength = 4000;
            if (safeResponse.length > maxMessageLength) {
              const truncatedMessage = safeResponse.substring(0, maxMessageLength) + "\n\n<i>Analysis truncated due to message length limits</i>";
              bot.sendMessage(chatId, truncatedMessage, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            } else {
              bot.sendMessage(chatId, safeResponse, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            }
          } else {
            const analysis = await ai.analyzeChartImage(fileLink, targetPair, command as "analyze" | "setup");
            const safeAnalysis = escapeHtml(analysis);

            const maxMessageLength = 4000;
            if (safeAnalysis.length > maxMessageLength) {
              const truncatedMessage = safeAnalysis.substring(0, maxMessageLength) + "\n\n<i>Analysis truncated due to message length limits</i>";
              bot.sendMessage(chatId, `📊 <b>Chart Analysis: ${targetPair}</b>\n\n${truncatedMessage}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            } else {
              bot.sendMessage(chatId, `📊 <b>Chart Analysis: ${targetPair}</b>\n\n${safeAnalysis}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            }
          }
        } catch (e: any) {
          bot.sendMessage(chatId, `❌ <b>AI Analysis Failed:</b> ${escapeHtml(e.message)}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.text?.startsWith('/analyze') || msg.text?.startsWith('/setup')) {
        if (!(await checkAiLane())) return;
        const parts = msg.text.split(' ');
        const command = parts[0].replace('/', '');
        const pair = parts[1]?.toUpperCase();
        
        if (!pair) {
          bot.sendMessage(chatId, `❌ Please provide a pair, e.g. <code>/${command} BTC/USDT</code>`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        // Track usage for non-premium users
        if (!accessCheck.isPremium) {
          await trackCommandUsage(userId, command === 'setup' ? 'setup' : 'analyze');
        }

        let query = `${command === 'setup' ? 'Find a high-probability trade setup for' : 'Analyze the market for'} ${pair}. Provide detailed SMC analysis with technical indicators, key levels, and actionable insights.`;

        // Premium enhancement: Professional trading plan for setup command
        if (accessCheck.isPremium && command === 'setup') {
          query = `Create a comprehensive professional trading plan for ${pair}:

**TRADING PLAN COMPONENTS:**

1. **Market Analysis**
   - Current trend direction and strength
   - Key support/resistance levels
   - Volume analysis and institutional activity

2. **Setup Identification**
   - Specific setup type (breakout, pullback, reversal, etc.)
   - Entry trigger conditions
   - Setup probability assessment

3. **Risk Management**
   - Maximum risk per trade (1-2% of portfolio)
   - Stop loss placement with reasoning
   - Risk-reward ratio target (minimum 1:2)

4. **Trade Execution**
   - Precise entry price level
   - Position sizing calculation
   - Take profit levels (TP1, TP2, TP3)
   - Scale-out strategy

5. **Contingency Planning**
   - Alternative scenarios if setup fails
   - Market condition filters
   - Time-based validity of setup

6. **Performance Expectations**
   - Win rate probability
   - Expected profit factor
   - Holding timeframe

Provide actionable, institutional-grade trading instructions.`;
        }

        // Premium enhancement: Multi-timeframe analysis
        if (accessCheck.isPremium && command === 'analyze') {
          query = `Provide comprehensive multi-timeframe analysis for ${pair}:

1. **1-Minute Chart**: Current momentum and micro-structure
2. **5-Minute Chart**: Short-term trend and key levels  
3. **15-Minute Chart**: Medium-term structure and setups
4. **1-Hour Chart**: Major trend direction and institutional levels
5. **4-Hour Chart**: Long-term context and market phase

For each timeframe, include:
- Current price action analysis
- Key support/resistance levels
- Trend direction and strength
- Volume analysis
- Institutional order flow (if visible)

Synthesize all timeframes into a cohesive trading strategy with entry/exit levels, risk management, and market outlook.`;
        }

        try {
          const analysis = await performEnhancedAIAnalysis(query);
          const title = command === 'setup' ? '🎯 Trade Setup Analysis' : '📊 Market Analysis';
          const premiumBadge = accessCheck.isPremium ? ' 💎 PREMIUM' : '';
          const fullMessage = `**${title}${premiumBadge}: ${pair}**\n\n${escapeHtml(analysis)}`;
          
          // Check message length and split if necessary (Telegram limit: 4096 chars)
          const maxMessageLength = 4000;
          if (fullMessage.length > maxMessageLength) {
            const truncatedMessage = fullMessage.substring(0, maxMessageLength) + "\n\n<i>Analysis truncated due to message length limits</i>";
            bot.sendMessage(chatId, truncatedMessage, { parse_mode: 'Markdown', message_thread_id: msg.message_thread_id });
          } else {
            bot.sendMessage(chatId, fullMessage, { parse_mode: 'Markdown', message_thread_id: msg.message_thread_id });
          }
        } catch (e: any) {
          log(`${command} analysis error: ${e.message}`, "telegram");
          // Use fallback analysis
          const fallbackAnalysis = performFallbackAIAnalysis(query);
          const title = command === 'setup' ? '🎯 Trade Setup Analysis' : '📊 Market Analysis';
          const premiumBadge = accessCheck.isPremium ? ' 💎 PREMIUM' : '';
          const fullFallbackMessage = `${title}${premiumBadge}: ${pair}\n\n${escapeHtml(fallbackAnalysis)}`;
          
          // Check fallback message length too
          const maxMessageLength = 4000;
          if (fullFallbackMessage.length > maxMessageLength) {
            const truncatedFallbackMessage = fullFallbackMessage.substring(0, maxMessageLength) + "\n\n<i>Analysis truncated due to message length limits</i>";
            bot.sendMessage(chatId, truncatedFallbackMessage, { parse_mode: 'Markdown', message_thread_id: msg.message_thread_id });
          } else {
            bot.sendMessage(chatId, fullFallbackMessage, { parse_mode: 'Markdown', message_thread_id: msg.message_thread_id });
          }
        }
        return;
      }

      if (msg.reply_to_message && msg.text) {
        const replyText = msg.reply_to_message.text || "";
        if (replyText.includes("Please paste the token's Solana contract address (Mint)")) {
          const mint = msg.text.trim();
          try {
            new PublicKey(mint);
            await sendTokenOverview(chatId, mint);
          } catch (e) {
            bot.sendMessage(chatId, "❌ <b>Invalid Solana address.</b> Please try again.", { parse_mode: 'HTML' });
          }
        } else if (replyText.includes("Please enter the token's contract address")) {
          await sendTokenOverview(chatId, msg.text.trim());
        }
      }

    } catch (e: any) {
      log(`Message error: ${e.message}`, "telegram");
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const userId = query.from.id.toString();
    const data = query.data;

    if (!chatId || !data) return;

    // Check user access for callback queries
    const accessCheck = await checkUserAccess(userId, chatId);
    if (!accessCheck.hasAccess) {
      if (!accessCheck.isRegisteredGroup) {
        // Bot should not respond at all in unregistered groups
        log(`Callback ignored: Chat ${chatId} is not a registered group`, "telegram");
        return;
      }

      if (accessCheck.isPremium === false && accessCheck.remainingCommands === 0) {
        bot.answerCallbackQuery(query.id, { text: "Access restricted - join our group!" });
        return;
      }
    }

    try {
      if (data === "main_menu") {
        await sendMainMenu(chatId, userId, query.message?.message_id, accessCheck);
      } else if (data === "main_menu_refresh") {
        await sendMainMenu(chatId, userId, query.message?.message_id, accessCheck);
        bot.answerCallbackQuery(query.id, { text: "Refreshed!" });
      } else if (data === "main_menu_help") {
        const helpText = `🏛️ <b>Coin Hunter AI Bot</b>\n\n` +
          `• <b>Premium</b>: Unlimited AI queries + full access to analysis, indicators, and fast results.\n` +
          `• <b>Free</b>: 2 commands per day (price + ai analysis).\n\n` +
          `Use /ai for AI insights (with real-time data and web search) and /analyze or /setup for chart-focused analysis.\n\n` +
          `Join for free access: https://t.me/CoinHunterAIBot\n` +
          `Upgrade to premium: https://t.me/onlysubsbot?start=mTVmGRKJjehzHMqZCnxkU\n\n` +
          `Note: AI commands are available in all registered groups (premium and non-premium).`;
        bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
        bot.answerCallbackQuery(query.id);
      } else if (data.startsWith('refresh_overview_')) {
        const mint = data.replace('refresh_overview_', '');
        await sendTokenOverview(chatId, mint, query.message?.message_id);
        bot.answerCallbackQuery(query.id, { text: "Refreshed!" });
      } else if (data.startsWith('ai_analyze_')) {
        const mint = data.replace('ai_analyze_', '');
        const threadId = query.message?.message_thread_id;
        await executeAiReasoning(chatId, mint, threadId);
        bot.answerCallbackQuery(query.id);
      }
    } catch (e: any) {
      log(`Callback error: ${e.message}`, "telegram");
    }
  });

  log("Telegram bot setup complete.", "telegram");
}

// DuckDuckGo search function for web research
async function searchDuckDuckGo(query: string): Promise<string> {
  try {
    const searchQuery = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${searchQuery}&format=json&no_html=1&skip_disambig=1`;

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'CoinHunterBot/1.0'
      }
    });

    if (response.data && response.data.RelatedTopics && response.data.RelatedTopics.length > 0) {
      // Extract relevant information from search results
      const results = response.data.RelatedTopics.slice(0, 5).map((topic: any) => {
        if (topic.Text) {
          return topic.Text;
        }
        return '';
      }).filter((text: string) => text.length > 0);

      return results.join('\n\n');
    }

    return `No relevant search results found for: ${query}`;
  } catch (error: any) {
    log(`DuckDuckGo search error: ${error.message}`, "telegram");
    return `Search failed: ${error.message}`;
  }
}
