// lib/p2p-engine.js

class P2PEngine {
  constructor(supabase) {
    this.supabase = supabase;
  }

  /**
   * Gift shares to another user
   */
  async giftShares({
    senderId,
    recipientEmail,
    investmentId,
    sharesToGift,
    message
  }) {
    
    // Step 1: Validate sender's investment
    const { data: investment, error: fetchError } = await this.supabase
      .from('investments')
      .select('*')
      .eq('id', investmentId)
      .eq('user_id', senderId)
      .single();
    
    if (fetchError || !investment) {
      throw new Error('Investment not found');
    }
    
    if (investment.shares < sharesToGift) {
      throw new Error(`You only own ${investment.shares} shares`);
    }
    
    if (sharesToGift <= 0) {
      throw new Error('Invalid share amount');
    }
    
    // Step 2: Find or invite recipient
    const { data: recipient } = await this.supabase
      .from('users')
      .select('*')
      .eq('email', recipientEmail)
      .single();
    
    if (!recipient) {
      // Recipient not on Trada yet - create pending gift
      const { data: pendingGift, error: pendingError } = await this.supabase
        .from('pending_gifts')
        .insert({
          sender_id: senderId,
          recipient_email: recipientEmail,
          investment_id: investmentId,
          shares: sharesToGift,
          message: message || '',
          status: 'pending',
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (pendingError) {
        throw new Error('Failed to create pending gift');
      }
      
      // TODO: Send invite email
      
      return {
        success: true,
        status: 'pending',
        message: 'Gift sent! Recipient will receive shares when they sign up.',
        giftId: pendingGift.id
      };
    }
    
    // Step 3: Execute immediate transfer (recipient exists)
    
    // Deduct from sender
    const remainingShares = investment.shares - sharesToGift;
    if (remainingShares < 0.0001) {
      // Gifted all shares
      await this.supabase
        .from('investments')
        .update({
          status: 'gifted',
          gifted_at: new Date().toISOString(),
          gifted_to: recipient.id
        })
        .eq('id', investmentId);
    } else {
      // Gifted partial shares
      const remainingAmount = (remainingShares / investment.shares) * investment.amount_usdc;
      await this.supabase
        .from('investments')
        .update({
          shares: remainingShares,
          amount_usdc: remainingAmount
        })
        .eq('id', investmentId);
    }
    
    // Add to recipient
    const { data: recipientInvestments } = await this.supabase
      .from('investments')
      .select('*')
      .eq('user_id', recipient.id)
      .eq('symbol', investment.symbol)
      .eq('status', 'confirmed')
      .single();
    
    if (recipientInvestments) {
      // Recipient already owns this stock - merge
      await this.supabase
        .from('investments')
        .update({
          shares: recipientInvestments.shares + sharesToGift,
          amount_usdc: recipientInvestments.amount_usdc + (sharesToGift * investment.purchase_price)
        })
        .eq('id', recipientInvestments.id);
    } else {
      // Create new investment for recipient
      await this.supabase
        .from('investments')
        .insert({
          user_id: recipient.id,
          company_id: investment.company_id,
          company_name: investment.company_name,
          company_icon: investment.company_icon,
          company_sector: investment.company_sector,
          symbol: investment.symbol,
          shares: sharesToGift,
          amount_usdc: sharesToGift * investment.purchase_price,
          purchase_price: investment.purchase_price,
          fee_amount: 0, // Gifts have no fee
          tx_id: null, // No blockchain transaction
          status: 'confirmed',
          received_from: senderId,
          wallet_id: recipient.wallet_id,
          created_at: new Date().toISOString()
        });
    }
    
    // Step 4: Record gift transactions
    await this.supabase
      .from('transactions')
      .insert([
        {
          user_id: senderId,
          type: 'gift_sent',
          recipient_id: recipient.id,
          amount: 0,
          symbol: investment.symbol,
          shares: sharesToGift,
          message: message || '',
          status: 'completed',
          created_at: new Date().toISOString()
        },
        {
          user_id: recipient.id,
          type: 'gift_received',
          sender_id: senderId,
          amount: 0,
          symbol: investment.symbol,
          shares: sharesToGift,
          message: message || '',
          status: 'completed',
          created_at: new Date().toISOString()
        }
      ]);
    
    // TODO: Send notification to recipient
    
    return {
      success: true,
      status: 'completed',
      message: `Successfully gifted ${sharesToGift} shares to ${recipientEmail}`,
      recipientId: recipient.id
    };
  }

  /**
   * Accept pending gifts (when new user signs up)
   */
  async acceptPendingGifts(userId, userEmail) {
    const { data: pendingGifts } = await this.supabase
      .from('pending_gifts')
      .select('*, investments(*)')
      .eq('recipient_email', userEmail)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());
    
    if (!pendingGifts || pendingGifts.length === 0) {
      return 0;
    }
    
    for (const gift of pendingGifts) {
      const investment = gift.investments;
      
      // Create investment for new user
      await this.supabase
        .from('investments')
        .insert({
          user_id: userId,
          company_id: investment.company_id,
          company_name: investment.company_name,
          company_icon: investment.company_icon,
          company_sector: investment.company_sector,
          symbol: investment.symbol,
          shares: gift.shares,
          amount_usdc: gift.shares * investment.purchase_price,
          purchase_price: investment.purchase_price,
          status: 'confirmed',
          received_from: gift.sender_id,
          created_at: new Date().toISOString()
        });
      
      // Mark gift as claimed
      await this.supabase
        .from('pending_gifts')
        .update({
          status: 'claimed',
          claimed_at: new Date().toISOString(),
          recipient_id: userId
        })
        .eq('id', gift.id);
      
      // Record transaction
      await this.supabase
        .from('transactions')
        .insert({
          user_id: userId,
          type: 'gift_received',
          sender_id: gift.sender_id,
          amount: 0,
          symbol: investment.symbol,
          shares: gift.shares,
          status: 'completed',
          created_at: new Date().toISOString()
        });
    }
    
    return pendingGifts.length;
  }

  /**
   * Search for recipient by email
   */
  async searchRecipient(query) {
    const { data: user } = await this.supabase
      .from('users')
      .select('id, full_name, username, email, avatar_url')
      .or(`email.eq.${query},username.eq.${query}`)
      .single();
    
    if (user) {
      return {
        found: true,
        user: {
          id: user.id,
          full_name: user.full_name,
          username: user.username,
          avatar: user.avatar_url || this.generateAvatar(user.full_name)
        }
      };
    }
    
    return {
      found: false,
      message: 'User not found. They will receive an invite to join Trada.'
    };
  }

  /**
   * Generate default avatar (initials)
   */
  generateAvatar(fullName) {
    const initials = fullName
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
    
    const colors = ['d4f57a', '4ade80', '60a5fa', 'f5c842', 'f87171'];
    const bgColor = colors[Math.floor(Math.random() * colors.length)];
    
    return `https://ui-avatars.com/api/?name=${initials}&background=${bgColor}&color=0a0c0b&bold=true`;
  }
}

module.exports = P2PEngine;
