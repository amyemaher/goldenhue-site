// netlify/functions/auth-request.js
// Generates a 6-digit OTP, stores it, sends email via Mailgun/Resend

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid request' }) }; }

  const email = (body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ message: 'Valid email required' }) };
  }

  // Generate 6-digit code
  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min

  // Store OTP
  const store = getStore('gh-otp');
  await store.set(email, JSON.stringify({ code, expiresAt, attempts: 0 }));

  // Send email via Resend (simplest email API — free tier is 3k emails/month)
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Goldenhue <hello@goldenhue.shop>',
      to: [email],
      subject: `Your Goldenhue code: ${code}`,
      html: `
        <div style="font-family:'Josefin Sans',Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;background:#faf8f4;">
          <div style="font-size:18px;letter-spacing:8px;text-transform:uppercase;color:#141210;margin-bottom:4px;">
            GOLDEN<span style="color:#e8602a;">HUE</span>
          </div>
          <div style="width:100%;height:3px;background:linear-gradient(90deg,#e8602a,#3d7abf,#b83810,#880030);margin-bottom:32px;"></div>
          <div style="font-size:14px;color:#7a7268;line-height:1.7;margin-bottom:24px;">
            Here's your verification code to activate your 10 free color season classifications:
          </div>
          <div style="font-size:40px;letter-spacing:12px;color:#141210;text-align:center;padding:24px;background:#fff;border:1px solid #e0d8ce;margin-bottom:24px;">
            ${code}
          </div>
          <div style="font-size:12px;color:#aaa;line-height:1.6;">
            This code expires in 15 minutes. If you didn't request this, you can ignore this email.
          </div>
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e0d8ce;font-size:11px;color:#bbb;letter-spacing:2px;text-transform:uppercase;">
            goldenhue.shop — Color Season Shopping
          </div>
        </div>
      `
    })
  });

  if (!emailRes.ok) {
    console.error('Email send failed:', await emailRes.text());
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'Failed to send email. Please try again.' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ message: 'Code sent' }) };

  } catch (err) {
    console.error('auth-request error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ message: err.message || 'Internal error' }) };
  }
};
