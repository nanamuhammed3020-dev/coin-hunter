import { groupBindings, signals as signalsTable, users, wallets as walletsTable, trades as tradesTable, userLanes } from "../shared/schema";
import TelegramBot from 'node-telegram-bot-api';
import { storage } from './storage';
import { log } from "./index";
import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { eq, and, or, count } from "drizzle-orm";
import { db } from "./db";
import { JupiterService } from "./solana";

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

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const jupiter = new JupiterService(rpcUrl);

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

    // Check if user already has wallets before creating a new one
    const existingWallets = await storage.getWallets(id);
    if (existingWallets.length === 0) {
      const keypair = Keypair.generate();
      await storage.createWallet({
        userId: id,
        publicKey: keypair.publicKey.toString(),
        privateKey: bs58.encode(keypair.secretKey),
        label: "Main Wallet",
        isMainnet: true,
        isActive: true,
        balance: "0"
      });
    }

    return user;
  };

  const executeBuy = async (userId: string, mint: string, amount: string, chatId: number) => {
    bot.sendMessage(chatId, "🚧 <b>Under Construction</b>\n\nTrading and wallet management features are currently under development. Please check back later.", { parse_mode: 'HTML' });
    return;
  };

  const executeSell = async (userId: string, mint: string, percent: number, chatId: number) => {
    bot.sendMessage(chatId, "🚧 <b>Under Construction</b>\n\nTrading and wallet management features are currently under development. Please check back later.", { parse_mode: 'HTML' });
    return;
  };

  const sendBuyAmountMenu = async (chatId: number, mint: string) => {
    bot.sendMessage(chatId, "🚧 <b>Under Construction</b>\n\nTrading and wallet management features are currently under development. Please check back later.", { parse_mode: 'HTML' });
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

      const message = `🧪 <b>Token Overview</b>\n\n` +
                    `📛 Name: ${name}\n` +
                    `💊 Symbol: $${symbol}\n` +
                    `🔗 Mint: <code>${mint}</code>\n\n` +
                    `📊 <b>Market</b>\n` +
                    `• Price: ${price}\n` +
                    `• Market Cap: ${mcap}\n` +
                    `• Liquidity: ${liq}\n` +
                    `• Volume (24h): ${vol}\n\n` +
                    `📈 <b>Activity (24h)</b>\n` +
                    `• Buys: ${buys}\n` +
                    `• Sells: ${sells}\n` +
                    `• Change: ${change}\n\n` +
                    `🌐 <b>Chart</b>\n` +
                    `https://dexscreener.com/solana/${mint}\n\n` +
                    `⚠️ <i>This is not financial advice.</i>`;

      const keyboard = [
        [{ text: "🛒 Buy (Under Construction)", callback_data: `under_construction` }],
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

  const executeAiReasoning = async (chatId: number, mint: string) => {
    bot.sendMessage(chatId, "🤖 <b>Generating AI Reasoning...</b>", { parse_mode: 'HTML' });
    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = response.data as any;
      const pair = data.pairs?.[0];
      if (!pair) throw new Error("Token data not found.");

      const marketData = JSON.stringify({
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        price: pair.priceUsd,
        fdv: pair.fdv,
        liquidity: pair.liquidity?.usd,
        volume24h: pair.volume?.h24,
        txns24h: pair.txns?.h24,
        priceChange24h: pair.priceChange?.h24
      });

      const { openRouterClient } = await import("./signals-worker");
      if (!openRouterClient) throw new Error("AI Client not initialized.");

      const aiResponse = await (openRouterClient as any).chat.completions.create({
        model: "google/gemini-2.0-flash-001",
        messages: [
          {
            role: "system",
            content: `You are an expert Solana token analyst. Analyze the following market data and provide reasoning in this EXACT format:
🤖 AI Token Reasoning

📛 [NAME] ($[SYMBOL])

🔐 Liquidity Analysis
• Liquidity: $[LIQUIDITY]
• LP Status: [Locked/Healthy/Risky based on data]

📊 Market Structure
• Market Cap (FDV): $[FDV]
• Volume (24h): $[VOLUME]

📈 Behavior
• Buys: [BUYS]
• Sells: [SELLS]
• Bias: [Bullish/Bearish Bias]

🧮 Risk Score
• Score: [X]/10

🚩 Rug-Risk Flags
• [Brief red flags or "No major red flags"]

[2-3 sentence short/brief insight on the token's potential and current momentum]

⚠️ This is probabilistic analysis, not financial advice.`
          },
          { role: "user", content: `Analyze this token: ${marketData}` }
        ]
      });

      const reasoning = aiResponse.choices[0].message.content;
      bot.sendMessage(chatId, reasoning, { parse_mode: 'HTML' });
    } catch (e: any) {
      log(`AI reasoning error: ${e.message}`, "telegram");
      bot.sendMessage(chatId, `❌ <b>AI Reasoning Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
  };

  async function sendMainMenu(chatId: number, userId: string, messageId?: number) {
    const activeWallet = await storage.getActiveWallet(userId);
    let balance = "0.000";
    
    if (activeWallet) {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        const bal = await connection.getBalance(new PublicKey(activeWallet.publicKey));
        balance = (bal / 1e9).toFixed(3);
        await storage.updateWalletBalance(activeWallet.id, balance);
      } catch (e) {
        log(`Failed to fetch real-time balance for ${activeWallet.publicKey}: ${e}`, "telegram");
        balance = activeWallet.balance || "0.000";
      }
    }

    const header = `🚀 <b>Welcome to Coin Hunter Bot</b>\n\n` +
                   `The most advanced Smart Money Concepts trading terminal on Solana.\n\n` +
                   `Wallet: <code>${activeWallet?.publicKey || 'None'}</code> (Tap to copy)\n` +
                   `Active Balance: <b>${balance} SOL</b>\n\n` +
                   `Quick Commands:\n` +
                   `• /buy [mint] [amount] - Manual Buy\n` +
                   `• /sell [mint] [percent] - Manual Sell\n` +
                   `• /settings - Configure Bot\n` +
                   `• /withdraw - Withdraw SOL\n` +
                   `• /history - View trade history`;

    const keyboard = [
      [{ text: "🔄 Refresh", callback_data: "main_menu_refresh" }],
      [{ text: "🛒 Buy (Under Construction)", callback_data: "under_construction" }, { text: "💰 Sell (Under Construction)", callback_data: "under_construction" }],
      [{ text: "📂 Positions (Under Construction)", callback_data: "under_construction" }, { text: "📜 History", callback_data: "menu_history" }],
      [{ text: "💸 Withdraw", callback_data: "menu_withdraw" }, { text: "⚙️ Settings", callback_data: "menu_settings" }]
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

      // Check for AI lane restriction in groups
      const checkAiLane = async () => {
        if (isPrivate) return true;
        
        // Find if there is ANY AI binding for this group
        const aiBinding = await db.select().from(groupBindings).where(
          and(
            eq(groupBindings.groupId, chatId.toString()),
            eq(groupBindings.market, "ai")
          )
        ).limit(1);
        
        if (aiBinding.length === 0) {
          // If no AI lane is bound at all to this group, we shouldn't respond to AI commands in this group
          log(`AI command blocked: Group ${chatId} has no AI lane bound.`, "telegram");
          return false;
        }
        
        const currentTopic = msg.message_thread_id?.toString() || null;
        // If the AI market is bound to a specific topic, restrict commands strictly to it
        if (aiBinding[0].topicId !== currentTopic) {
          bot.sendMessage(chatId, `⚠️ <b>Action Restricted</b>\n\nPlease use the designated <b>AI Analysis</b> topic for this request.`, { 
            parse_mode: 'HTML', 
            message_thread_id: msg.message_thread_id 
          });
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

        bot.sendMessage(chatId, "🤖 <b>Processing AI Request...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        const { openRouterClient } = await import("./signals-worker");
        if (!openRouterClient) {
          bot.sendMessage(chatId, "❌ AI service not initialized.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        try {
          const response = await openRouterClient.chat.completions.create({
            model: "google/gemini-2.0-flash-001",
            messages: [
              { role: "system", content: "You are an expert crypto and forex analyst using Smart Money Concepts (SMC)." },
              { role: "user", content: query }
            ]
          });
          bot.sendMessage(chatId, response.choices[0].message?.content || "No response.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (e: any) {
          bot.sendMessage(chatId, `❌ AI Error: ${e.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.text?.length && msg.text.length >= 32 && msg.text.length <= 44 && !msg.text.includes(' ')) {
        if (!(await checkAiLane())) return;
        const mint = msg.text.trim();
        try {
          new PublicKey(mint);
          await sendTokenOverview(chatId, mint, undefined, msg.message_thread_id);
          return;
        } catch (e) {
          // Not a valid public key, ignore
        }
      }

      // Handle under construction commands
      if (msg.text?.startsWith('/buy') || msg.text?.startsWith('/sell') || msg.text === '/wallet' || msg.text === '/withdraw' || msg.text === '/settings' || msg.text === '/history') {
        if (msg.text === '/withdraw' && msg.reply_to_message) {
            // This is a reply to the withdraw message, but features are under construction
        }
        bot.sendMessage(chatId, "🚧 <b>Under Construction</b>\n\nTrading and wallet management features are currently under development. Please check back later.", { 
            parse_mode: 'HTML',
            message_thread_id: msg.message_thread_id
        });
        return;
      }

      if (msg.text === '/bind' || msg.text?.startsWith('/bind ')) {
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

      if (msg.text === '/help' || msg.text === '/start' || msg.text === '/menu') {
        const helpMessage = `🏛️ <b>SMC Trading Bot - Command Guide</b>\n\n` +
          `<b>Core Commands:</b>\n` +
          `• /start or /menu - Access the main trading dashboard\n` +
          `• /bind [market] - Bind group to <code>crypto</code>, <code>forex</code>, or <code>ai</code>\n` +
          `• /analyze [pair] - Get a deep-dive institutional analysis\n` +
          `• /setup [pair] - Find a neutral breakout/pullback setup\n` +
          `• /ai [query] - Ask the AI specialist any trading question\n` +
          `• /unbind [market] - Unbind group from signals\n` +
          `• /settings - Configure security and trading preferences\n` +
          `• /history - View your recent trade history\n` +
          `• /withdraw - Withdraw SOL to an external wallet\n\n` +
          `<b>Advanced Features:</b>\n` +
          `• Send/Reply to a <b>Chart Image</b> with <code>/analyze</code> or <code>/setup</code> for visual AI analysis.\n` +
          `• Paste a <b>Solana Mint Address</b> to get a quick token overview and safety check.\n\n` +
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

      if (msg.text === '/settings') {
        const keyboard = [
          [{ text: "🔒 Security & MEV", callback_data: "settings_mev" }],
          [{ text: "🎯 Auto TP/SL", callback_data: "settings_tpsl" }],
          [{ text: "🔑 Wallet Export", callback_data: "settings_export" }],
          [{ text: "🔙 Back to Menu", callback_data: "main_menu" }]
        ];
        bot.sendMessage(chatId, "⚙️ <b>Bot Settings</b>\n\nConfigure your trading preferences below:", { 
          parse_mode: 'HTML', 
          reply_markup: { inline_keyboard: keyboard } 
        });
        return;
      }

      if (msg.text === '/history') {
        const trades = await storage.getTrades(userId);
        if (trades.length === 0) {
          bot.sendMessage(chatId, "📜 <b>Trade History</b>\n\nYou have no trade history.", { parse_mode: 'HTML' });
          return;
        }
        const msgHistory = `📜 <b>Trade History</b>\n\n` +
                   trades.slice(0, 10).map(t => `${t.status === 'completed' ? '✅' : '❌'} ${t.mint.slice(0, 8)}... - ${t.amountIn} SOL`).join('\n');
        bot.sendMessage(chatId, msgHistory, { parse_mode: 'HTML' });
        return;
      }

      if (msg.text === '/withdraw') {
        bot.sendMessage(chatId, "💰 <b>Withdraw SOL</b>\n\nPlease reply to this message with the Solana destination address:", { 
          parse_mode: 'HTML', 
          reply_markup: { force_reply: true } 
        });
        return;
      }

      if (msg.photo && (msg.caption?.startsWith('/analyze') || msg.caption?.startsWith('/setup'))) {
        if (!(await checkAiLane())) return;
        const parts = msg.caption.split(' ');
        const command = parts[0].replace('/', '');
        const pair = parts[1]?.toUpperCase();
        
        // Handle image analysis
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        
        bot.sendMessage(chatId, `⏳ <b>Analyzing chart image for ${pair || 'detected pair'}...</b>`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        
        const workerModule = await import("./signals-worker") as any;
        const aiModule = await import("./ai") as any;
        const worker = workerModule.default || workerModule;
        const ai = aiModule.default || aiModule;
        
        let targetPair: string | undefined = pair;
        if (!targetPair) {
          const detected = await ai.extractPairFromImage(fileLink);
          targetPair = detected || undefined;
        }
        
        if (!targetPair) {
          bot.sendMessage(chatId, "❌ <b>Could not detect trading pair from image.</b> Please provide it manually: <code>/analyze BTC/USDT</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        
        const sym = targetPair.includes('/') ? targetPair.split('/')[0].toUpperCase() : targetPair.toUpperCase();
        const forexSymbols = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'USD', 'XAU', 'XAG'];
        const isForex = forexSymbols.includes(sym) || (targetPair.includes('/') && forexSymbols.includes(targetPair.split('/')[1].toUpperCase()));
        const marketType = isForex ? "forex" : "crypto";

        worker.runScanner(marketType, true, chatId.toString(), msg.message_thread_id?.toString(), targetPair, command as "analyze" | "setup", fileLink);
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

        const feedbackMsg = command === 'setup' 
          ? `⏳ <b>Hang on while we generate a NEUTRAL setup for you...</b>`
          : `⏳ <b>Hang on while we perform a NEUTRAL analysis for you...</b>`;
          
        bot.sendMessage(chatId, feedbackMsg, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        const workerModule = await import("./signals-worker") as any;
        const worker = workerModule.default || workerModule;
        
        // Robust market type detection
        const forexSymbols = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'USD', 'XAU', 'XAG'];
        const symPrefix = pair.slice(0, 3);
        const isForex = forexSymbols.includes(symPrefix) || (pair.includes('/') && (forexSymbols.includes(pair.split('/')[0]) || forexSymbols.includes(pair.split('/')[1])));
        const marketType = isForex ? "forex" : "crypto";
        
        // Ensure pair has a slash for scanner consistency if it doesn't already
        let normalizedPair = pair;
        if (!pair.includes('/') && pair.length >= 6) {
          normalizedPair = `${pair.slice(0, pair.length - 4)}/${pair.slice(pair.length - 4)}`;
        }
        
        log(`Manual command: ${command} for ${normalizedPair} (${marketType})`, "telegram");
        worker.runScanner(marketType, true, chatId.toString(), msg.message_thread_id?.toString(), normalizedPair, command as "analyze" | "setup");
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
        } else if (replyText.includes("Please reply to this message with the Solana destination address")) {
          const address = msg.text.trim();
          try {
            new PublicKey(address);
            bot.sendMessage(chatId, `💰 <b>Withdrawal</b>\nAddress: <code>${address}</code>\n\nPlease reply to this message with the amount of SOL to withdraw:`, { 
              parse_mode: 'HTML', 
              reply_markup: { force_reply: true } 
            });
          } catch (e) {
            bot.sendMessage(chatId, "❌ <b>Invalid Solana Address.</b> Please try again.", { parse_mode: 'HTML' });
          }
        } else if (replyText.includes("Please reply to this message with the amount of SOL to withdraw")) {
          const amount = parseFloat(msg.text);
          const addressMatch = replyText.match(/Address: <code>(.*?)<\/code>/);
          if (!isNaN(amount) && addressMatch) {
            const address = addressMatch[1];
            try {
              const activeWallet = await storage.getActiveWallet(userId);
              if (!activeWallet) throw new Error("No active wallet.");
              
              const connection = new Connection(rpcUrl, "confirmed");
              const balance = await connection.getBalance(new PublicKey(activeWallet.publicKey));
              const lamports = Math.floor(amount * 1e9);
              
              if (balance < lamports + 5000) throw new Error("Insufficient balance for withdrawal + fees.");
              
              const transaction = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: new PublicKey(activeWallet.publicKey),
                  toPubkey: new PublicKey(address),
                  lamports: lamports,
                })
              );
              
              const keypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
              const signature = await connection.sendTransaction(transaction, [keypair]);
              await connection.confirmTransaction(signature);
              
              // Update balance immediately after withdrawal
              const newBal = await connection.getBalance(new PublicKey(activeWallet.publicKey));
              await storage.updateWalletBalance(activeWallet.id, (newBal / 1e9).toFixed(3));

              bot.sendMessage(chatId, `✅ <b>Withdrawal Successful!</b>\n\nTX: <a href="https://solscan.io/tx/${signature}">${signature.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
            } catch (e: any) {
              bot.sendMessage(chatId, `❌ <b>Withdrawal Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
            }
          }
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

    try {
      if (data === "main_menu") {
        await sendMainMenu(chatId, userId, query.message?.message_id);
      } else if (data === "main_menu_refresh") {
        await sendMainMenu(chatId, userId, query.message?.message_id);
        bot.answerCallbackQuery(query.id, { text: "Refreshed!" });
      } else if (data === "under_construction") {
        bot.answerCallbackQuery(query.id, { text: "🚧 Under Construction" });
        bot.sendMessage(chatId, "🚧 <b>Under Construction</b>\n\nThis feature is currently under development. Please check back later.", { parse_mode: 'HTML' });
      } else if (data === "menu_settings") {
        const keyboard = [
          [{ text: "🔒 Security & MEV", callback_data: "settings_mev" }],
          [{ text: "🎯 Auto TP/SL", callback_data: "settings_tpsl" }],
          [{ text: "🔑 Wallet Export", callback_data: "settings_export" }],
          [{ text: "🔙 Back to Menu", callback_data: "main_menu" }]
        ];
        try {
          await bot.editMessageText("⚙️ <b>Bot Settings</b>\n\nConfigure your trading preferences below:", { 
            chat_id: chatId, 
            message_id: query.message?.message_id,
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: keyboard } 
          });
        } catch (e: any) {
          if (!e.message.includes("message is not modified")) throw e;
        }
      } else if (data === "menu_history") {
        const trades = await storage.getTrades(userId);
        if (trades.length === 0) {
          bot.sendMessage(chatId, "📜 <b>Trade History</b>\n\nYou have no trade history.", { parse_mode: 'HTML' });
        } else {
          const msgHistory = `📜 <b>Trade History</b>\n\n` +
                     trades.slice(0, 10).map(t => `${t.status === 'completed' ? '✅' : '❌'} ${t.mint.slice(0, 8)}... - ${t.amountIn} SOL`).join('\n');
          bot.sendMessage(chatId, msgHistory, { parse_mode: 'HTML' });
        }
        bot.answerCallbackQuery(query.id);
      } else if (data.startsWith('refresh_overview_')) {
        const mint = data.replace('refresh_overview_', '');
        await sendTokenOverview(chatId, mint, query.message?.message_id);
        bot.answerCallbackQuery(query.id, { text: "Refreshed!" });
      } else if (data.startsWith('ai_analyze_')) {
        const mint = data.replace('ai_analyze_', '');
        await executeAiReasoning(chatId, mint);
        bot.answerCallbackQuery(query.id);
      } else if (data === "menu_withdraw") {
        bot.sendMessage(chatId, "💰 <b>Withdraw SOL</b>\n\nPlease reply to this message with the Solana destination address:", { 
          parse_mode: 'HTML', 
          reply_markup: { force_reply: true } 
        });
        bot.answerCallbackQuery(query.id);
      }
    } catch (e: any) {
      log(`Callback error: ${e.message}`, "telegram");
    }
  });

  log("Telegram bot setup complete.", "telegram");
}
