import OpenAI from "openai";

let client: OpenAI | null = null;

function initClient() {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let baseURL: string | undefined;
  
  if (process.env.OPENROUTER_API_KEY) {
    baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  } else {
    baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
  }
  
  if (!apiKey) {
    console.error("AI Client: No API key found in environment variables");
    return null;
  }
  
  client = new OpenAI({ 
    apiKey, 
    baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      "HTTP-Referer": "https://replit.com",
      "X-Title": "SMC Trading Bot",
    }
  });
  return client;
}

export async function extractPairFromImage(imageUrl: string): Promise<string | null> {
  const c = initClient();
  if (!c) return null;

  try {
    const model = "anthropic/claude-3-haiku";
    const response: any = await c.chat.completions.create({
      model: model,
      max_tokens: 500,
      messages: [
        { 
          role: "system", 
          content: `You are a professional trading chart validator and analyst. Your task is to:
          1. Determine if the provided image is a TRADING CHART.
          2. Extract the trading pair (e.g., BTC/USDT), timeframe (e.g., 1H, 4H), and recent price action (candles).
          3. If it is a chart, respond with ONLY the trading pair symbol in BASE/QUOTE format.
          4. If it is NOT a chart, respond with "NONE".
          Strictly only respond with the pair or "NONE".` 
        },
        { role: "user", content: [
          { type: "text", text: "Identify the trading pair from this image if it is a trading chart. Look at symbols, headers, and axes." },
          { type: "image_url", image_url: { url: imageUrl } }
        ]}
      ],
      extra_headers: {
        "HTTP-Referer": "https://replit.com",
        "X-Title": "SMC Trading Bot"
      }
    } as any);

    const text = (response as any).choices?.[0]?.message?.content || "";
    const t = (text || "").trim();
    if (!t || /NONE/i.test(t)) return null;

    // Normalize common formats (e.g., BTC/USDT, BTCUSDT, EUR/USD)
    const match = t.match(/([A-Z0-9]{2,10})\s*[-\/]?\s*([A-Z0-9]{2,10})/i);
    if (match) {
      const base = match[1].toUpperCase();
      const quote = match[2].toUpperCase();
      // Filter out non-trading words detected as symbols
      const filterWords = ['TESTICLE', 'CHART', 'CANDLE', 'PRICE', 'TRADING', 'SETUP', 'ANALYSIS', 'PAIR', 'SYMBOL'];
      if (filterWords.includes(base) || filterWords.includes(quote)) return null;
      return `${base}/${quote}`;
    }
    
    // If it's a single word but looks like a pair (e.g., BTCUSDT)
    if (t.length >= 6 && t.length <= 12 && !t.includes('/')) {
        const base = t.slice(0, t.length - 4).toUpperCase();
        const quote = t.slice(t.length - 4).toUpperCase();
        return `${base}/${quote}`;
    }

    return null;
  } catch (e: any) {
    console.error("Pair extraction error:", e);
    return null;
  }
}

export async function analyzeChartImage(imageUrl: string, pair?: string, command: 'analyze' | 'setup' = 'analyze'): Promise<string> {
  const c = initClient();
  if (!c) return "AI service unavailable for chart analysis.";

  try {
    const now = new Date();
    const currentTime = now.toISOString();
    const utcTime = now.toUTCString();

    const systemPrompt = `You are an expert SMC (Smart Money Concepts) trader and technical analyst. Analyze the provided chart image with professional precision.

CURRENT TIME CONTEXT:
- UTC Time: ${utcTime}
- Analysis Time: ${currentTime}

ANALYSIS REQUIREMENTS:
1. **Price Action**: Identify current price, recent highs/lows, candle patterns
2. **Technical Indicators**: RSI, MACD, moving averages, support/resistance levels
3. **Volume Analysis**: Volume patterns, institutional activity
4. **SMC Concepts**: 
   - Liquidity zones (high/low liquidity)
   - Institutional order flow
   - Market manipulation patterns
   - Smart money positioning
5. **Timeframes**: Identify the chart timeframe and context
6. **Risk Management**: Entry/exit points, stop losses, position sizing
7. **Market Structure**: Higher highs/lows, lower highs/lows, range markets

${command === 'setup' ? 
  'FOCUS: Find high-probability trade setups with clear entry/exit criteria.' :
  'FOCUS: Provide comprehensive market analysis with actionable insights.'}

RESPONSE FORMAT:
- **Current Market Structure**
- **Key Levels** (Support/Resistance/Liquidity)
- **Technical Indicators**
- **SMC Analysis**
- **Trade Setup** (if applicable)
- **Risk Assessment**
- **Time Context**

Be precise, professional, and actionable. Include confidence levels for your analysis.`;

    const userPrompt = pair 
      ? `Analyze this ${pair} chart image. Provide detailed SMC analysis and ${command === 'setup' ? 'identify potential trade setups' : 'market insights'}.`
      : `Analyze this trading chart image. Identify the trading pair, timeframe, and provide comprehensive SMC analysis.`;

    const model = "anthropic/claude-3-haiku";
    const response: any = await c.chat.completions.create({
      model: model,
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: imageUrl } }
        ]}
      ],
      extra_headers: {
        "HTTP-Referer": "https://replit.com",
        "X-Title": "SMC Trading Bot"
      }
    } as any);

    return (response as any).choices?.[0]?.message?.content || "Chart analysis unavailable.";
  } catch (e: any) {
    console.error("Chart analysis error:", e);
    return `Chart analysis failed: ${e.message}`;
  }
}
