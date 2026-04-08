import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Production-safe email service using Nodemailer with Gmail
 * Handles sending audit report completion emails to users
 */
class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  /**
   * Initialize Gmail transporter with environment variables
   */
  initializeTransporter() {
    try {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD
        }
      });

      console.log('✅ Email transporter initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize email transporter:', error.message);
      this.transporter = null;
    }
  }

  /**
   * Send audit report completion email
   * @param {string} to - Recipient email address
   * @param {string} pdfUrl - PDF download URL
   * @param {string} userName - User's first name (optional)
   * @returns {Promise<boolean>} Success status
   */
  async sendReportEmail(to, pdfUrl, userName = '') {
    if (!this.transporter) {
      console.error('❌ Email transporter not initialized');
      return false;
    }

    if (!to || !pdfUrl) {
      console.error('❌ Missing required parameters: to and pdfUrl');
      return false;
    }

    const subject = 'Your AI Audit Report is Ready 🚀';
    const html = this.generateEmailHtml(pdfUrl, userName);

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: to,
      subject: subject,
      html: html
    };

    try {
      console.log(`📧 Sending report email to: ${to}`);
      
      const result = await this.transporter.sendMail(mailOptions);
      
      console.log(`✅ Email sent successfully | messageId: ${result.messageId}`);
      return true;
      
    } catch (error) {
      console.error(`❌ Failed to send email to ${to}:`, error.message);
      return false;
    }
  }

  /**
   * Generate HTML email content
   * @param {string} pdfUrl - PDF download URL
   * @param {string} userName - User's first name
   * @returns {string} HTML content
   */
  generateEmailHtml(pdfUrl, userName) {
    const greeting = userName ? `Hi ${userName},` : 'Hello,';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your AI Audit Report is Ready</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
        }
        .container {
            background-color: #ffffff;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .logo {
            font-size: 24px;
            font-weight: bold;
            color: #4f46e5;
            margin-bottom: 10px;
        }
        .title {
            font-size: 28px;
            font-weight: bold;
            color: #1f2937;
            margin-bottom: 10px;
        }
        .subtitle {
            font-size: 16px;
            color: #6b7280;
            margin-bottom: 30px;
        }
        .content {
            margin-bottom: 30px;
        }
        .cta-button {
            display: inline-block;
            background-color: #4f46e5;
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            margin: 20px 0;
        }
        .cta-button:hover {
            background-color: #4338ca;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
            font-size: 14px;
            color: #6b7280;
        }
        .feature-list {
            background-color: #f9fafb;
            padding: 20px;
            border-radius: 6px;
            margin: 20px 0;
        }
        .feature-list li {
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🚀 Odito</div>
            <h1 class="title">Your AI Audit Report is Ready!</h1>
            <p class="subtitle">Comprehensive SEO analysis completed for your website</p>
        </div>

        <div class="content">
            <p>${greeting}</p>
            
            <p>Great news! Your comprehensive AI audit report has been generated successfully. The report includes detailed insights about:</p>
            
            <ul class="feature-list">
                <li>✅ SEO Performance Analysis</li>
                <li>✅ AI Visibility Score</li>
                <li>✅ Content Optimization Opportunities</li>
                <li>✅ Technical SEO Issues</li>
                <li>✅ Competitive Insights</li>
                <li>✅ Actionable Recommendations</li>
            </ul>

            <p>Your detailed PDF report is now ready for download:</p>

            <div style="text-align: center;">
                <a href="${pdfUrl}" class="cta-button">Download Your Report</a>
            </div>

            <p><strong>Note:</strong> The report contains proprietary analysis and recommendations tailored specifically for your website. Keep it secure and use it to guide your SEO strategy.</p>
        </div>

        <div class="footer">
            <p>Need help? Contact our support team</p>
            <p>© 2024 Odito. All rights reserved.</p>
        </div>
    </div>
</body>
</html>
    `;
  }

  /**
   * Test email configuration
   * @returns {Promise<boolean>} Test success status
   */
  async testConfiguration() {
    if (!this.transporter) {
      console.error('❌ Email transporter not initialized');
      return false;
    }

    try {
      await this.transporter.verify();
      console.log('✅ Email configuration verified successfully');
      return true;
    } catch (error) {
      console.error('❌ Email configuration test failed:', error.message);
      return false;
    }
  }
}

// Create singleton instance
const emailService = new EmailService();

// Export convenience function
export const sendEmail = (to, pdfUrl, userName = '') => {
  return emailService.sendReportEmail(to, pdfUrl, userName);
};

// Export service instance and class
export default emailService;
export { EmailService };
