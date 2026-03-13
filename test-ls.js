const puppeteer = require("puppeteer-core");
async function test() {
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:9222`, defaultViewport: null });
    const targets = await browser.targets();
    let page = null;
    for (const t of targets) {
        if (t.url().includes('workbench.html')) {
            try { page = await t.page(); break; } catch (e) { }
        }
    }
    if (!page) { console.log("No page"); process.exit(1); }

    // Try to list recent workspaces
    try {
        const res = await page.evaluate(async () => {
            // Is there a vscode API exposed? Or maybe local storage?
            return Object.keys(localStorage).filter(k => k.toLowerCase().includes('workspace') || k.toLowerCase().includes('recent'));
        });
        console.log("LocalStorage Keys:", res);

        const res2 = await page.evaluate(async () => {
            for (let i = 0; i < localStorage.length; i++) {
                let key = localStorage.key(i);
                if (key.includes('recentList') || key.includes('history') || key.includes('workspaces')) {
                    return { key, val: localStorage.getItem(key) };
                }
            }
            return null;
        });
        console.log("Recent items:", res2);

    } catch (e) {
        console.error("Error", e);
    }

    browser.disconnect();
    process.exit(0);
}
test();
