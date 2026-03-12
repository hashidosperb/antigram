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
          console.log("Found Lexical editor element!");
          await el.focus();
          // Type natively very fast
          await page.keyboard.type("Testing from script: Hello World", { delay: 10 });
          console.log("Typed 'Testing from script: Hello World'");
          await new Promise(r => setTimeout(r, 500));
          
          const html = await page.$eval("[data-lexical-editor=\"true\"]", e => e.innerHTML);
          console.log("HTML inside editor after typing:", html);

          // Find send button based on what we saw earlier
          const parentHtml = await page.evaluate(() => {
              const wrap = document.getElementById("antigravity.agentSidePanelInputBox");
              return wrap ? wrap.outerHTML : "no wrap";
          });
          console.log("Parent HTML:", parentHtml.substring(0, 1000));
          
          // Test pressing Enter
          console.log("Pressing Enter");
          await page.keyboard.press("Enter");
          await new Promise(r => setTimeout(r, 500));
          console.log("HTML inside editor after enter:", await page.$eval("[data-lexical-editor=\"true\"]", e => e.innerHTML));
      } else {
          console.log("Lexical editor Not found!");
      }
    } catch(e) {
        console.error("Error:", e);
    }
  } else {
      console.log("workbench.html not found");
  }
  browser.disconnect();
}
test();
