const puppeteer = require("puppeteer-core");
async function test() {
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
    const targets = await browser.targets();
    let workbenchPages = [];
    for (const t of targets) {
        if (t.url().includes('workbench.html')) {
            try {
                const p = await t.page();
                workbenchPages.push({ p, url: t.url(), id: t._targetId });
            } catch (e) { }
        }
    }
    console.log("Found workbench pages:", workbenchPages.length);
    for (let i = 0; i < workbenchPages.length; i++) {
        const title = await workbenchPages[i].p.title();
        console.log(`Page ${i}: title=${title}, url=${workbenchPages[i].url}`);
    }
    browser.disconnect();
}
test();
