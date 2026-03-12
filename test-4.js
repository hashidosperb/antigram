const puppeteer = require("puppeteer-core");
async function test() {
  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  const targets = await browser.targets();
  const t = targets.find(t => t.url().includes("workbench.html"));
  if (t) {
    try {
      const page = await t.page();
      const el = await page.$("[data-lexical-editor=\"true\"]");
      if (el) {
          
          await el.focus();
          await page.keyboard.press("Backspace");
          console.log("Pressed Backspace");

          await page.keyboard.type("Testing generate explicitly: Hello World", { delay: 10 });
          console.log("Typed 'Testing generate explicitly'");
          
          await new Promise(r => setTimeout(r, 500));
          const sendBtn = await page.$eval('[data-tooltip-id*="input-send-button" i]', btn => {btn.click(); return true;}).catch(()=>false);
          console.log("Clicked Send button:", sendBtn);

          // Now poll quickly for generation state
          let maxTries = 10;
          while(maxTries > 0) {
              await new Promise(r => setTimeout(r, 1000));
              const state = await page.evaluate(() => {
                  const send = document.querySelector('[data-tooltip-id*="input-send-button" i]');
                  const cancel = document.querySelector('[data-tooltip-id*="input-cancel-button" i]');
                  const hasSquare = !!document.querySelector('button svg.lucide-square, button svg[class*="lucide-square"]');
                  
                  return {
                     hasSendBtn: !!send,
                     hasCancelBtn: !!cancel,
                     hasSquareIcon: hasSquare
                  };
              });
              console.log("State:", state);
              maxTries--;
          }
      }
    } catch(e) { console.log(e); }
  }
  browser.disconnect();
}
test();
