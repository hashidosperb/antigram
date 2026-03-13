const puppeteer = require("puppeteer-core");
async function test() {
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
    const targets = await browser.targets();
    for (const t of targets) {
        console.log(t.url());
    }
    browser.disconnect();
}
test();
