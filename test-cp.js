const puppeteer = require("puppeteer-core");
const CDP_PORT = process.env.CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

async function test() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const targets = await browser.targets();
  let page = null;
  for (const t of targets) {
    if (t.url().includes('workbench.html')) {
        try {
            page = await t.page();
            break;
        } catch(e) {}
    }
  }
  
  if (!page) {
      console.log("No page found");
      return;
  }
  
  await page.bringToFront();

  // Try opening command palette via F1
  await page.keyboard.press('F1');
  await new Promise(r => setTimeout(r, 1000));
  
  await page.screenshot({path: 'test-cp.png'});
  console.log("Screenshot saved.");

  // Clean up
  await page.keyboard.press('Escape');
  
  browser.disconnect();
}

test();
