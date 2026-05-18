// lib/portfolio-analytics.js

class PortfolioAnalytics {
  constructor(supabase, priceAPI) {
    this.supabase = supabase;
    this.priceAPI = priceAPI;
  }

  /**
   * Calculate complete portfolio metrics
   */
  async calculatePortfolio(userId) {
    // Fetch all active investments
    const { data: investments, error } = await this.supabase
      .from('investments')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'confirmed');
    
    if (error) {
      throw new Error('Failed to fetch investments');
    }
    
    if (!investments || investments.length === 0) {
      return this.emptyPortfolio();
    }
    
    // Fetch live prices for all holdings
    const symbols = [...new Set(investments.map(inv => inv.symbol))];
    const livePrices = await this.priceAPI.getBatch(symbols);
    
    // Calculate metrics
    let totalInvested = 0;
    let totalCurrentValue = 0;
    const holdings = [];
    
    for (const inv of investments) {
      const livePrice = livePrices[inv.symbol];
      if (!livePrice) continue;
      
      const currentValue = inv.shares * livePrice.price;
      const costBasis = inv.amount_usdc;
      const pnl = currentValue - costBasis;
      const pnlPercent = (pnl / costBasis) * 100;
      
      totalInvested += costBasis;
      totalCurrentValue += currentValue;
      
      holdings.push({
        id: inv.id,
        symbol: inv.symbol,
        company_name: inv.company_name,
        company_icon: inv.company_icon,
        company_sector: inv.company_sector,
        shares: parseFloat(inv.shares.toFixed(8)),
        purchase_price: parseFloat(inv.purchase_price.toFixed(2)),
        current_price: parseFloat(livePrice.price.toFixed(2)),
        cost_basis: parseFloat(costBasis.toFixed(2)),
        current_value: parseFloat(currentValue.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        pnl_percent: parseFloat(pnlPercent.toFixed(2)),
        change_today: livePrice.change_percent,
        allocation: 0 // Will calculate after loop
      });
    }
    
    // Calculate allocation percentages
    holdings.forEach(h => {
      h.allocation = parseFloat(((h.current_value / totalCurrentValue) * 100).toFixed(2));
    });
    
    // Total P&L
    const totalPnL = totalCurrentValue - totalInvested;
    const totalPnLPercent = (totalPnL / totalInvested) * 100;
    
    // Fetch wallet balance
    const { data: user } = await this.supabase
      .from('users')
      .select('wallet_id')
      .eq('id', userId)
      .single();
    
    let walletBalance = 0;
    if (user && user.wallet_id) {
      try {
        // This would call Circle API
        walletBalance = 0; // Placeholder - implement Circle balance check
      } catch(e) {
        console.error('Wallet balance error:', e);
      }
    }
    
    return {
      summary: {
        total_invested: parseFloat(totalInvested.toFixed(2)),
        current_value: parseFloat(totalCurrentValue.toFixed(2)),
        total_pnl: parseFloat(totalPnL.toFixed(2)),
        total_pnl_percent: parseFloat(totalPnLPercent.toFixed(2)),
        wallet_balance: parseFloat(walletBalance.toFixed(2)),
        total_assets: parseFloat((totalCurrentValue + walletBalance).toFixed(2)),
        holdings_count: holdings.length
      },
      holdings: holdings.sort((a, b) => b.current_value - a.current_value),
      allocation: this.calculateAllocation(holdings)
    };
  }

  /**
   * Calculate asset allocation breakdown
   */
  calculateAllocation(holdings) {
    const bySector = {};
    const byCountry = {};
    
    holdings.forEach(h => {
      // By sector
      const sector = h.company_sector || 'Other';
      bySector[sector] = (bySector[sector] || 0) + h.allocation;
      
      // By country (simplified - you'd enrich this with company data)
      const country = ['JMIA', 'DANGCEM', 'GTCO', 'MTN'].includes(h.symbol) ? 'Africa' : 'US';
      byCountry[country] = (byCountry[country] || 0) + h.allocation;
    });
    
    return {
      by_sector: Object.entries(bySector).map(([name, pct]) => ({ 
        name, 
        pct: parseFloat(pct.toFixed(2)) 
      })),
      by_country: Object.entries(byCountry).map(([name, pct]) => ({ 
        name, 
        pct: parseFloat(pct.toFixed(2)) 
      }))
    };
  }

  /**
   * Empty portfolio state
   */
  emptyPortfolio() {
    return {
      summary: {
        total_invested: 0,
        current_value: 0,
        total_pnl: 0,
        total_pnl_percent: 0,
        wallet_balance: 0,
        total_assets: 0,
        holdings_count: 0
      },
      holdings: [],
      allocation: { by_sector: [], by_country: [] }
    };
  }

  /**
   * Get user transaction history
   */
  async getTransactionHistory(userId, limit = 50) {
    const { data: transactions, error } = await this.supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      throw new Error('Failed to fetch transactions');
    }
    
    return transactions || [];
  }
}

module.exports = PortfolioAnalytics;
