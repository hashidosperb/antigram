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

  let inputFocused = false;
  let isLexical = false;
  const messageText = "Testing full logic 3";
  const selectors = [
    '[data-lexical-editor="true"]', // Antigravity IDE Sidebar
    '.monaco-editor textarea',
    '.editor textarea',
    'textarea[placeholder*="agent" i]',
    'textarea[placeholder*="message" i]',
    'textarea',
    '[contenteditable="true"]'
  ];

  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.focus();
        
        if (selector === '[data-lexical-editor="true"]') {
            isLexical = true;
            // Clear Lexical Editor safely
            await page.keyboard.down('Meta');
            await page.keyboard.press('a');
            await page.keyboard.up('Meta');
            await page.keyboard.press('Backspace');

            // Type text
            const lines = messageText.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (i > 0) {
                 await page.keyboard.down('Shift');
                 await page.keyboard.press('Enter');
                 await page.keyboard.up('Shift');
              }
              await page.keyboard.type(lines[i], { delay: 10 });
            }
        } else {
           // Type natively very fast
           await page.keyboard.type(messageText, { delay: 10 });
        }
        
        inputFocused = true;
        break;
      }
    } catch (e) {
      // Ignore and try next selector
    }
  }

  console.log("Input focused:", inputFocused, "isLexical:", isLexical);
  
  // Wait before evaluating
  await new Promise(r => setTimeout(r, 500));
  const html = await page.$eval("[data-lexical-editor=\"true\"]", e => e.innerHTML);
  console.log("HTML inside editor after typing:", html);
  
  browser.disconnect();
}

test();
