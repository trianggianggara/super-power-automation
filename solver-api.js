/**
 * Turnstile Solver API
 * Expose autoregister captcha solver via HTTP endpoint
 */

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

// Import existing solver
const { solveTurnstile } = require('./utils/captcha_solver.js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

/**
 * POST /refresh-cookie
 * Body: { cookie: "session-token-value", url: "https://chatgpt.com" }
 * Response: { success: true, cookie: "fresh-token", elapsed: 5432 }
 */
app.post('/refresh-cookie', async (req, res) => {
  const startTime = Date.now();
  const { cookie, url = 'https://chatgpt.com' } = req.body;

  if (!cookie) {
    return res.status(400).json({ success: false, error: 'Cookie required' });
  }

  let browser;
  try {
    console.log(`[${new Date().toISOString()}] Refreshing cookie for ${url}...`);

    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // Set old cookie
    await context.addCookies([{
      name: '__Secure-next-auth.session-token',
      value: cookie,
      domain: '.chatgpt.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }]);

    const page = await context.newPage();

    // Navigate to target
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check for Turnstile
    const turnstileFrame = page.frameLocator('iframe[src*="turnstile"]');
    const isTurnstilePresent = await turnstileFrame.locator('body').count() > 0;

    if (isTurnstilePresent) {
      console.log('Turnstile detected, solving...');
      await solveTurnstile(page); // Use autoregister solver
      await page.waitForTimeout(2000);
    }

    // Wait for page to settle
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      console.log('Networkidle timeout, continuing...');
    });

    // Extract fresh cookies
    const cookies = await context.cookies();
    const freshSessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token');

    await browser.close();

    if (!freshSessionToken) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to extract fresh cookie' 
      });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Cookie refreshed successfully (${elapsed}ms)`);

    return res.json({
      success: true,
      cookie: freshSessionToken.value,
      elapsed,
      turnstile_solved: isTurnstilePresent
    });

  } catch (error) {
    console.error('Error refreshing cookie:', error);
    if (browser) await browser.close().catch(() => {});
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'turnstile-solver', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`🚀 Turnstile Solver API running on http://localhost:${PORT}`);
  console.log(`   POST /refresh-cookie - Refresh ChatGPT cookie`);
  console.log(`   GET  /health         - Health check`);
});
