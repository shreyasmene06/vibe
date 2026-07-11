// Reproduce the user's exact flow with a real browser session:
//  1. sign in as user@yaksha.com via the Firebase auth emulator
//  2. navigate to the course page
//  3. click into peer-review item-A, observe form state
//  4. submit item-A with a public URL
//  5. click into peer-review item-B, observe form state
//  6. click back into peer-review item-A, observe form state
//
// Capture: console logs, network requests, page text.
import { chromium } from 'playwright';

const APP = 'http://[::1]:5173';
const FIREBASE = 'http://127.0.0.1:9099';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Capture console.
  page.on('console', msg => {
    console.log(`[browser ${msg.type()}]`, msg.text());
  });
  // Capture network for the summary endpoint specifically.
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('submissions/summary') || url.includes('peer-review')) {
      console.log(`[net] ${resp.status()} ${resp.request().method()} ${url}`);
      try {
        const text = await resp.text();
        const trimmed = text.length > 400 ? text.slice(0, 400) + '...' : text;
        console.log(`[net body]`, trimmed);
      } catch {}
    }
  });

  // Navigate to login page first to bootstrap Firebase JS.
  await page.goto(APP);
  await page.waitForLoadState('networkidle');

  // Sign in via the auth emulator and inject the token.
  const signIn = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@yaksha.com', password: 'student123', returnSecureToken: true }),
    });
    return await r.json();
  }, FIREBASE);
  console.log('signed in:', signIn.email, signIn.localId);

  await page.evaluate(({ idToken, refreshToken, localId, email }) => {
    const userPayload = {
      uid: localId,
      email,
      emailVerified: true,
      stsTokenManager: {
        accessToken: idToken,
        refreshToken,
        expirationTime: Date.now() + 3600 * 1000,
      },
      providerId: 'password',
    };
    // The Firebase JS SDK reads the standard key shape; persist for all keys.
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('firebase:authUser:')) {
        localStorage.setItem(k, JSON.stringify(userPayload));
      }
    }
    // Also set the auth header token the openapi-fetch interceptor reads.
    localStorage.setItem('firebase-auth-token', idToken);
  }, signIn);

  // Navigate to the wdwdwdwd course page.
  await page.goto(`${APP}/student/learn/6a4f991c9f163399356c7c6d/6a4f991c9f163399356c7c6e`);
  await page.waitForTimeout(3000);
  console.log('--- URL after course nav:', page.url());

  // Look for peer-review item links in the sidebar.
  // The first one we'll find should be item-A.
  const sidebarLinks = await page.locator('a:has-text("Peer-Review"), button:has-text("Peer-Review")').all();
  console.log('peer-review links found in sidebar:', sidebarLinks.length);

  if (sidebarLinks.length < 2) {
    console.log('!!! not enough peer-review items to test');
    await browser.close();
    return;
  }

  // Click the first peer-review item.
  console.log('=== clicking first peer-review item ===');
  await sidebarLinks[0].click();
  await page.waitForTimeout(3000);
  console.log('URL after click:', page.url());
  // Look at form state
  const status1 = await page.locator(':has-text("Status:")').first().textContent().catch(() => 'no status text');
  console.log('STATUS item-A:', status1);

  // Take a screenshot.
  await page.screenshot({ path: '/tmp/sp-itemA-initial.png' });

  // Try to fill + submit if the form is editable.
  const submitBtn = page.locator('button:has-text("Submit")').first();
  const submitVisible = await submitBtn.isVisible().catch(() => false);
  console.log('Submit button visible:', submitVisible);
  if (submitVisible) {
    // Fill URL field.
    const urlInput = page.locator('input[placeholder*="http"], input[type="url"]').first();
    await urlInput.fill('https://raw.githubusercontent.com/expressjs/express/master/package.json').catch(() => {});
    await page.waitForTimeout(2000);  // wait for accessibility check
    await submitBtn.click();
    await page.waitForTimeout(3000);
    console.log('=== submitted item-A ===');
  }

  // Click the second peer-review item (item-B).
  console.log('=== clicking second peer-review item ===');
  const sidebarLinksAfter = await page.locator('a:has-text("Peer-Review"), button:has-text("Peer-Review")').all();
  if (sidebarLinksAfter.length >= 2) {
    await sidebarLinksAfter[1].click();
    await page.waitForTimeout(3000);
    console.log('URL after click 2:', page.url());
    const status2 = await page.locator(':has-text("Status:")').first().textContent().catch(() => 'no status text');
    console.log('STATUS item-B:', status2);
    await page.screenshot({ path: '/tmp/sp-itemB-after.png' });

    // Click back to item-A.
    console.log('=== clicking back to first peer-review item ===');
    const sidebarLinksAfter2 = await page.locator('a:has-text("Peer-Review"), button:has-text("Peer-Review")').all();
    if (sidebarLinksAfter2.length >= 1) {
      await sidebarLinksAfter2[0].click();
      await page.waitForTimeout(3000);
      console.log('URL after click back:', page.url());
      const status3 = await page.locator(':has-text("Status:")').first().textContent().catch(() => 'no status text');
      console.log('STATUS item-A (revisit):', status3);
      await page.screenshot({ path: '/tmp/sp-itemA-revisit.png' });
    }
  }

  await browser.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });