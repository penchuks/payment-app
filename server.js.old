// server.js - Updated with business logic modules
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Import business logic modules
const InvestmentEngine = require('./lib/investment-engine');
const P2PEngine = require('./lib/p2p-engine');
const PortfolioAnalytics = require('./lib/portfolio-analytics');

// Environment variables
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const DEFAULT_WALLET_ID = process.env.DEFAULT_WALLET_ID;
const ENTITY_SECRET = process.env.ENTITY_SECRET;
const TOKEN_ID = process.env.TOKEN_ID || '36b1737e-549e-5406-84af-6d7c1a57c0ab';

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Cache objects
let priceCache = {};
let historyCache = {};
let sentimentCache = { data: null, ts: 0 };

// Circle API wrapper
const CircleAPI = {
  async request(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.circle.com',
        path: endpoint,
        method: method,
        headers: {
          'Authorization': `Bearer ${CIRCLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch(e) {
            resolve({ code: res.statusCode, message: data });
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  },

  async transfer({ fromWalletId, toWalletId, amount, entitySecret, idempotencyKey }) {
    const result = await this.request('POST', '/v1/w3s/developer/transactions/transfer', {
      idempotencyKey: idempotencyKey,
      walletId: fromWalletId,
      entitySecretCiphertext: entitySecret,
      amounts: [amount],
      destinationAddress: toWalletId,
      tokenId: TOKEN_ID,
      feeLevel: 'MEDIUM'
    });

    if (result.data && result.data.id) {
      return {
        success: true,
        transactionId: result.data.id
      };
    }

    return {
      success: false,
      error: result.message || 'Transfer failed'
    };
  },

  async getBalance(walletId) {
    const result = await this.request('GET', `/v1/w3s/wallets/${walletId}/balances`);
    if (result.data && result.data.tokenBalances) {
      const usdcBalance = result.data.tokenBalances.find(b => b.token.symbol === 'USDC');
      return parseFloat(usdcBalance?.amount || 0);
    }
    return 0;
  }
};

// Price API wrapper
const PriceAPI = {
  async get(symbol) {
    const now = Date.now();
    const cached = priceCache[symbol];
    if (cached && (now - cached.ts) < 5 * 60 * 1000) {
      return cached;
    }

    return new Promise((resolve) => {
      https.get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const quote = parsed['Global Quote'];
            if (quote) {
              const price = parseFloat(quote['05. price']);
              const change = parseFloat(quote['09. change']);
              const changePercent = quote['10. change percent'];
              
              const result = {
                symbol: symbol,
                price: price,
                change: change.toFixed(2),
                change_percent: changePercent,
                timestamp: now
              };
              
              priceCache[symbol] = { ...result, ts: now };
              resolve(result);
            } else {
              resolve({ symbol, price: 0, change: '0', change_percent: '0%', timestamp: now });
            }
          } catch(e) {
            resolve({ symbol, price: 0, change: '0', change_percent: '0%', timestamp: now });
          }
        });
      }).on('error', () => resolve({ symbol, price: 0, change: '0', change_percent: '0%', timestamp: now }));
    });
  },

  async getBatch(symbols) {
    const result = {};
    for (const symbol of symbols) {
      result[symbol] = await this.get(symbol);
      await new Promise(r => setTimeout(r, 200)); // Rate limit
    }
    return result;
  }
};

// Initialize business logic engines
const investmentEngine = new InvestmentEngine(supabase, CircleAPI);
const p2pEngine = new P2PEngine(supabase);
const portfolioAnalytics = new PortfolioAnalytics(supabase, PriceAPI);

// Helper functions
function json(res, data, code = 200) {
  res.writeHead(code, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch(e) {
        resolve({});
      }
    });
  });
}

function generateCiphertext() {
  return crypto.randomBytes(32).toString('hex');
}

// Main server
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, { ok: true });
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const path = urlObj.pathname;

  // ── Investment Endpoints ──────────────────────────────────────────

  if (path === '/api/invest' && req.method === 'POST') {
    const body = await readBody(req);
    const { user_id, symbol, amount, company_name, company_icon, company_sector } = body;

    try {
      // Get current price
      const currentPrice = await PriceAPI.get(symbol);
      
      // Get user data
      const { data: user } = await supabase
        .from('users')
        .select('wallet_id')
        .eq('id', user_id)
        .single();
      
      if (!user) {
        return json(res, { error: 'User not found' }, 404);
      }

      // Execute investment
      const result = await investmentEngine.executeInvestment({
        userId: user_id,
        symbol: symbol,
        companyName: company_name,
        companyIcon: company_icon,
        companySector: company_sector,
        amountUSDC: parseFloat(amount),
        currentPrice: currentPrice,
        walletId: user.wallet_id,
        treasuryWalletId: DEFAULT_WALLET_ID,
        entitySecret: ENTITY_SECRET
      });

      return json(res, result);
    } catch (error) {
      console.error('Investment error:', error);
      return json(res, { error: error.message }, 500);
    }
  }

  if (path === '/api/sell' && req.method === 'POST') {
    const body = await readBody(req);
    const { user_id, investment_id, shares, symbol, wallet_address } = body;

    try {
      const currentPrice = await PriceAPI.get(symbol);

      const result = await investmentEngine.sellInvestment({
        userId: user_id,
        investmentId: investment_id,
        sharesToSell: parseFloat(shares),
        currentPrice: currentPrice,
        walletAddress: wallet_address,
        treasuryWalletId: DEFAULT_WALLET_ID,
        entitySecret: ENTITY_SECRET
      });

      return json(res, result);
    } catch (error) {
      console.error('Sell error:', error);
      return json(res, { error: error.message }, 500);
    }
  }

  // ── P2P / Gift Endpoints ──────────────────────────────────────────

  if (path === '/api/gift' && req.method === 'POST') {
    const body = await readBody(req);
    const { sender_id, recipient_email, investment_id, shares, message } = body;

    try {
      const result = await p2pEngine.giftShares({
        senderId: sender_id,
        recipientEmail: recipient_email,
        investmentId: investment_id,
        sharesToGift: parseFloat(shares),
        message: message
      });

      return json(res, result);
    } catch (error) {
      console.error('Gift error:', error);
      return json(res, { error: error.message }, 500);
    }
  }

  if (path === '/api/users/search' && req.method === 'GET') {
    const query = urlObj.searchParams.get('email') || urlObj.searchParams.get('username');
    
    try {
      const result = await p2pEngine.searchRecipient(query);
      return json(res, result);
    } catch (error) {
      return json(res, { error: error.message }, 500);
    }
  }

  // ── Portfolio Endpoints ───────────────────────────────────────────

  if (path === '/api/portfolio' && req.method === 'GET') {
    const userId = urlObj.searchParams.get('user_id');
    
    try {
      const portfolio = await portfolioAnalytics.calculatePortfolio(userId);
      return json(res, portfolio);
    } catch (error) {
      console.error('Portfolio error:', error);
      return json(res, { error: error.message }, 500);
    }
  }

  if (path === '/api/portfolio-full' && req.method === 'GET') {
    const userId = urlObj.searchParams.get('user_id');
    
    try {
      const portfolio = await portfolioAnalytics.calculatePortfolio(userId);
      return json(res, portfolio);
    } catch (error) {
      console.error('Portfolio error:', error);
      return json(res, { error: error.message }, 500);
    }
  }

  if (path === '/api/transactions' && req.method === 'GET') {
    const userId = urlObj.searchParams.get('user_id');
    const limit = parseInt(urlObj.searchParams.get('limit') || '50');
    
    try {
      const transactions = await portfolioAnalytics.getTransactionHistory(userId, limit);
      return json(res, { transactions });
    } catch (error) {
      return json(res, { error: error.message }, 500);
    }
  }

  // ── Price Endpoints (existing) ────────────────────────────────────

  if (path === '/api/prices' && req.method === 'GET') {
    const symbols = (urlObj.searchParams.get('symbols') || 'CRCL,JMIA').split(',');
    const prices = await PriceAPI.getBatch(symbols);
    return json(res, { prices });
  }

  if (path === '/api/price' && req.method === 'GET') {
    const symbol = urlObj.searchParams.get('symbol') || 'CRCL';
    const price = await PriceAPI.get(symbol);
    return json(res, price);
  }

  // ── Auth Endpoints (existing - add token refresh) ─────────────────

  if (path === '/api/auth/refresh' && req.method === 'POST') {
    const body = await readBody(req);
    const { refresh_token } = body;
    
    if (!refresh_token) {
      return json(res, { error: 'Refresh token required' }, 400);
    }

    try {
      const { data, error } = await supabase.auth.refreshSession({ refresh_token });
      
      if (error) {
        return json(res, { error: error.message }, 401);
      }

      return json(res, { 
        session: data.session,
        user: data.user 
      });
    } catch(e) {
      console.error('Token refresh error:', e);
      return json(res, { error: 'Token refresh failed' }, 500);
    }
  }

  // Default 404
  return json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`🚀 Trada server running on port ${PORT}`);
  console.log('📦 Business logic modules loaded:');
  console.log('   ✓ Investment Engine');
  console.log('   ✓ P2P Engine');
  console.log('   ✓ Portfolio Analytics');
});
