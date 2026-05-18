// lib/investment-engine.js
const crypto = require('crypto');

class InvestmentEngine {
  constructor(supabase, circleAPI) {
    this.supabase = supabase;
    this.circleAPI = circleAPI;
  }

  /**
   * Calculate fractional shares for a given investment amount
   */
  calculateShares(amountUSDC, pricePerShare, feePercent = 2) {
    const netAmount = amountUSDC * (1 - feePercent / 100);
    const shares = netAmount / pricePerShare;
    const feeAmount = amountUSDC - netAmount;
    
    return {
      shares: parseFloat(shares.toFixed(8)),
      netAmount: parseFloat(netAmount.toFixed(2)),
      feeAmount: parseFloat(feeAmount.toFixed(2)),
      effectivePrice: parseFloat((amountUSDC / shares).toFixed(2))
    };
  }

  /**
   * Validate investment parameters
   */
  validateInvestment(userId, symbol, amount, currentPrice) {
    const errors = [];
    
    if (!userId || !symbol || !amount) {
      errors.push('Missing required fields');
    }
    
    if (amount < 5) {
      errors.push('Minimum investment is $5 USDC');
    }
    
    if (amount > 10000) {
      errors.push('Maximum single investment is $10,000 USDC');
    }
    
    if (!currentPrice || currentPrice.price <= 0) {
      errors.push('Unable to fetch current price');
    } else {
      const priceAge = Date.now() - (currentPrice.timestamp || Date.now());
      if (priceAge > 5 * 60 * 1000) {
        errors.push('Price data is stale, please refresh');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Execute investment transaction
   */
  async executeInvestment({
    userId,
    symbol,
    companyName,
    companyIcon,
    companySector,
    amountUSDC,
    currentPrice,
    walletId,
    treasuryWalletId,
    entitySecret
  }) {
    
    // Step 1: Validate
    const validation = this.validateInvestment(userId, symbol, amountUSDC, currentPrice);
    if (!validation.valid) {
      throw new Error(validation.errors.join(', '));
    }
    
    // Step 2: Check wallet balance
    const balance = await this.circleAPI.getBalance(walletId);
    if (balance < amountUSDC) {
      throw new Error(`Insufficient balance. You have $${balance.toFixed(2)} USDC`);
    }
    
    // Step 3: Calculate shares
    const calc = this.calculateShares(amountUSDC, currentPrice.price);
    
    // Step 4: Transfer USDC to treasury
    const transferResult = await this.circleAPI.transfer({
      fromWalletId: walletId,
      toWalletId: treasuryWalletId,
      amount: amountUSDC.toFixed(2),
      entitySecret: entitySecret,
      idempotencyKey: crypto.randomUUID()
    });
    
    if (!transferResult.success) {
      throw new Error('Transfer failed: ' + (transferResult.error || 'Unknown error'));
    }
    
    // Step 5: Record investment in database
    const { data: investment, error: dbError } = await this.supabase
      .from('investments')
      .insert({
        user_id: userId,
        company_id: symbol.toLowerCase(),
        company_name: companyName,
        company_icon: companyIcon || '📊',
        company_sector: companySector || 'Unknown',
        symbol: symbol,
        shares: calc.shares,
        amount_usdc: amountUSDC,
        purchase_price: currentPrice.price,
        fee_amount: calc.feeAmount,
        tx_id: transferResult.transactionId,
        status: 'confirmed',
        wallet_id: walletId,
        created_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (dbError) {
      console.error('Database error:', dbError);
      throw new Error('Failed to record investment');
    }
    
    // Step 6: Record transaction
    await this.supabase
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'investment',
        amount: amountUSDC,
        symbol: symbol,
        shares: calc.shares,
        price: currentPrice.price,
        tx_id: transferResult.transactionId,
        status: 'completed',
        created_at: new Date().toISOString()
      });
    
    // Step 7: Record revenue
    await this.supabase
      .from('revenue')
      .insert({
        user_id: userId,
        investment_id: investment.id,
        type: 'investment_fee',
        amount: calc.feeAmount,
        created_at: new Date().toISOString()
      });
    
    return {
      success: true,
      investment: investment,
      shares: calc.shares,
      netAmount: calc.netAmount,
      feeAmount: calc.feeAmount,
      transactionId: transferResult.transactionId
    };
  }

  /**
   * Sell investment
   */
  async sellInvestment({
    userId,
    investmentId,
    sharesToSell,
    currentPrice,
    walletAddress,
    treasuryWalletId,
    entitySecret
  }) {
    
    // Step 1: Fetch investment record
    const { data: investment, error: fetchError } = await this.supabase
      .from('investments')
      .select('*')
      .eq('id', investmentId)
      .eq('user_id', userId)
      .single();
    
    if (fetchError || !investment) {
      throw new Error('Investment not found');
    }
    
    if (investment.status !== 'confirmed') {
      throw new Error('Investment is not active');
    }
    
    // Step 2: Validate shares
    if (sharesToSell > investment.shares) {
      throw new Error(`You only own ${investment.shares} shares`);
    }
    
    if (sharesToSell <= 0) {
      throw new Error('Invalid share amount');
    }
    
    // Step 3: Calculate proceeds
    const grossProceeds = sharesToSell * currentPrice.price;
    const sellFee = grossProceeds * 0.015; // 1.5% sell fee
    const netProceeds = grossProceeds - sellFee;
    
    // Step 4: Transfer USDC to user
    const transferResult = await this.circleAPI.transfer({
      fromWalletId: treasuryWalletId,
      toWalletId: investment.wallet_id,
      amount: netProceeds.toFixed(2),
      entitySecret: entitySecret,
      idempotencyKey: crypto.randomUUID()
    });
    
    if (!transferResult.success) {
      throw new Error('Transfer failed: ' + (transferResult.error || 'Unknown error'));
    }
    
    // Step 5: Update investment record
    const remainingShares = investment.shares - sharesToSell;
    
    if (remainingShares < 0.0001) {
      // Fully sold
      await this.supabase
        .from('investments')
        .update({
          status: 'sold',
          sold_at: new Date().toISOString(),
          sell_price: currentPrice.price,
          sell_proceeds: netProceeds
        })
        .eq('id', investmentId);
    } else {
      // Partially sold
      const remainingAmount = (remainingShares / investment.shares) * investment.amount_usdc;
      await this.supabase
        .from('investments')
        .update({
          shares: remainingShares,
          amount_usdc: remainingAmount
        })
        .eq('id', investmentId);
    }
    
    // Step 6: Record transaction
    await this.supabase
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'sell',
        amount: netProceeds,
        symbol: investment.symbol,
        shares: sharesToSell,
        price: currentPrice.price,
        tx_id: transferResult.transactionId,
        status: 'completed',
        created_at: new Date().toISOString()
      });
    
    // Step 7: Record revenue
    await this.supabase
      .from('revenue')
      .insert({
        user_id: userId,
        investment_id: investmentId,
        type: 'sell_fee',
        amount: sellFee,
        created_at: new Date().toISOString()
      });
    
    return {
      success: true,
      proceeds: netProceeds,
      fee: sellFee,
      remainingShares: remainingShares,
      transactionId: transferResult.transactionId
    };
  }
}

module.exports = InvestmentEngine;
