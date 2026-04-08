import nodemailer from 'nodemailer';

// Email transporter configuration
const createEmailTransporter = () => {
  return nodemailer.createTransporter({
    service: 'gmail', // or your email provider
    auth: {
      user: process.env.ADMIN_EMAIL_USER,
      pass: process.env.ADMIN_EMAIL_PASS
    }
  });
};

// Real admin alert implementation
export async function alertAdminOnPermanentFailure(eventLog, error) {
  try {
    const transporter = createEmailTransporter();
    
    const emailContent = {
      from: process.env.ADMIN_EMAIL_FROM || process.env.ADMIN_EMAIL_USER,
      to: process.env.ADMIN_ALERT_EMAIL,
      subject: `🚨 CRITICAL: Stripe Webhook Permanently Failed`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
            <h2 style="margin: 0;">🚨 CRITICAL PAYMENT SYSTEM ALERT</h2>
          </div>
          
          <h3>Webhook Processing Permanently Failed</h3>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">Event ID:</td>
              <td style="padding: 10px;">${eventLog.stripeEventId}</td>
            </tr>
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">Event Type:</td>
              <td style="padding: 10px;">${eventLog.eventType}</td>
            </tr>
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">Retry Count:</td>
              <td style="padding: 10px;">${eventLog.retryCount}</td>
            </tr>
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">User ID:</td>
              <td style="padding: 10px;">${eventLog.metadata?.userId || 'Unknown'}</td>
            </tr>
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">Customer ID:</td>
              <td style="padding: 10px;">${eventLog.metadata?.customerId || 'Unknown'}</td>
            </tr>
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">Error:</td>
              <td style="padding: 10px; color: #721c24;">${error.message}</td>
            </tr>
            <tr>
              <td style="background: #f8f9fa; padding: 10px; font-weight: bold;">Failed At:</td>
              <td style="padding: 10px;">${new Date().toISOString()}</td>
            </tr>
          </table>
          
          <div style="background: #fff3cd; color: #856404; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <strong>⚠️ IMMEDIATE ACTION REQUIRED:</strong>
            <ul style="margin: 10px 0;">
              <li>Payment processing may be affected</li>
              <li>Customer payments could be failing</li>
              <li>Check Stripe Dashboard for failed events</li>
              <li>Investigate error and fix handler logic</li>
            </ul>
          </div>
          
          <div style="background: #d1ecf1; color: #0c5460; padding: 15px; border-radius: 5px;">
            <strong>📋 Next Steps:</strong>
            <ol style="margin: 10px 0;">
              <li>Log into Stripe Dashboard</li>
              <li>Review failed webhook event: ${eventLog.stripeEventId}</li>
              <li>Check application logs for detailed error</li>
              <li>Fix the underlying issue</li>
              <li>Manually reprocess event if needed</li>
            </ol>
          </div>
          
          <hr style="margin: 30px 0;">
          <p style="color: #6c757d; font-size: 12px;">
            This is an automated alert from the Odito Payment System.<br>
            Event ID: ${eventLog.stripeEventId} | Timestamp: ${new Date().toISOString()}
          </p>
        </div>
      `
    };

    // Send email
    await transporter.sendMail(emailContent);
    
    // Also log to console for immediate visibility
    console.error(`[ALERT] Admin notified of permanent webhook failure | eventId=${eventLog.stripeEventId} | emailSent=true`);
    
    // Optional: Send Slack notification if webhook URL is configured
    if (process.env.SLACK_WEBHOOK_URL) {
      await sendSlackAlert(eventLog, error);
    }
    
    return true;
    
  } catch (emailError) {
    console.error(`[CRITICAL] Failed to send admin alert | eventId=${eventLog.stripeEventId} | emailError=${emailError.message}`);
    
    // Fallback: At least create a database record for admin dashboard
    try {
      const AdminAlert = (await import('../model/AdminAlert.js')).default;
      await AdminAlert.create({
        type: 'webhook_permanent_failure',
        severity: 'critical',
        eventId: eventLog.stripeEventId,
        eventType: eventLog.eventType,
        userId: eventLog.metadata?.userId,
        error: error.message,
        retryCount: eventLog.retryCount,
        emailSent: false,
        emailError: emailError.message,
        createdAt: new Date()
      });
      console.log(`[FALLBACK] Admin alert stored in database | eventId=${eventLog.stripeEventId}`);
    } catch (dbError) {
      console.error(`[CRITICAL] All alert methods failed | eventId=${eventLog.stripeEventId} | dbError=${dbError.message}`);
    }
    
    return false;
  }
}

// Optional Slack notification
async function sendSlackAlert(eventLog, error) {
  try {
    const slackPayload = {
      text: `🚨 CRITICAL: Stripe Webhook Permanently Failed`,
      attachments: [{
        color: 'danger',
        fields: [
          { title: 'Event ID', value: eventLog.stripeEventId, short: true },
          { title: 'Event Type', value: eventLog.eventType, short: true },
          { title: 'Retry Count', value: eventLog.retryCount.toString(), short: true },
          { title: 'User ID', value: eventLog.metadata?.userId || 'Unknown', short: true },
          { title: 'Error', value: error.message, short: false }
        ],
        footer: 'Odito Payment System',
        ts: Math.floor(Date.now() / 1000)
      }]
    };

    const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload)
    });

    if (response.ok) {
      console.log(`[SLACK] Alert sent successfully | eventId=${eventLog.stripeEventId}`);
    } else {
      console.error(`[SLACK] Failed to send alert | eventId=${eventLog.stripeEventId} | status=${response.status}`);
    }
    
  } catch (slackError) {
    console.error(`[SLACK] Error sending alert | eventId=${eventLog.stripeEventId} | error=${slackError.message}`);
  }
}
