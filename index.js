require('dotenv').config();
// Polyfill global fetch for older Node.js versions (puppeteer may call globalThis.fetch)
if (typeof globalThis.fetch !== 'function') {
  const http = require('http');
  const https = require('https');
  const { URL } = require('url');

  globalThis.fetch = function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: `${u.pathname}${u.search}`,
            method: options.method || 'GET',
            headers: options.headers || {}
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                statusText: res.statusMessage,
                text: () => Promise.resolve(data),
                json: () => {
                  try { return Promise.resolve(JSON.parse(data)); } catch (e) { return Promise.reject(e); }
                },
                headers: {
                  get: (name) => res.headers[name.toLowerCase()]
                }
              });
            });
          }
        );

        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  };
}
const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer-core');

// Constants
const CDP_PORT = process.env.CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
  console.error('\n ⚠️  Missing configuration! Launching setup wizard...\n');
  const { execSync } = require('child_process');
  try {
    execSync(`node "${require('path').join(__dirname, 'setup.js')}"`, { stdio: 'inherit' });
    // Reload environment after setup
    require('dotenv').config({ override: true });
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_USER_ID) {
      console.error('\n ❌ Setup was not completed. Please run: node setup.js\n');
      process.exit(1);
    }
    // Restart the process with the new config
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => process.exit(code));
    return;
  } catch (e) {
    console.error('\n ❌ Setup failed. Please run: node setup.js\n');
    process.exit(1);
  }
}

// Helper: Escape special characters for Telegram Markdown
function escTg(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Global browser instance for persistent connection
let globalBrowser = null;

// Initialize Telegram Bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Middleware to check specific TELEGRAM_USER_ID for security
const allowedUsers = TELEGRAM_USER_ID.split(',').map(id => id.trim());
bot.use((ctx, next) => {
  if (ctx.from && allowedUsers.includes(ctx.from.id.toString())) {
    return next();
  } else {
    console.log(`Unauthorized access attempt by user: ${ctx.from ? ctx.from.id : 'unknown'}`);
  }
});

// Helper: Connect to IDE with retry mechanism
async function connectToIDE(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      // Return existing connected browser if available
      if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
      }

      console.log('Connecting to IDE...');
      globalBrowser = await puppeteer.connect({
        browserURL: CDP_URL,
        defaultViewport: null
      });
      return globalBrowser;
    } catch (err) {
      console.log(`Connection attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) {
        throw new Error(`Could not connect to IDE on port ${CDP_PORT}. Ensure it is running with --remote-debugging-port=${CDP_PORT}`);
      }
      await new Promise(res => setTimeout(res, 1000)); // Wait 1s before retry
    }
  }
}

// Helper: Connect to IDE and find the Agent page
async function getAgentPage() {
  const browser = await connectToIDE();
  const targets = await browser.targets();
  let agentPage = null;

  // Find the workbench.html target which contains the agent sidebar
  // We iterate backwards to prefer the most recently opened window
  const reversedTargets = [...targets].reverse();
  for (const t of reversedTargets) {
    if (t.url().includes('workbench.html')) {
      try {
        agentPage = await t.page();
        if (agentPage) break;
      } catch (e) { }
    }
  }

  // Fallback to legacy loop
  if (!agentPage) {
    const pages = await browser.pages();
    const reversedPages = [...pages].reverse();
    for (const page of reversedPages) {
      const url = page.url().toLowerCase();
      const title = (await page.title()).toLowerCase();
      if (url.includes('agent') || url.includes('launchpad') || title.includes('agent') || title.includes('launchpad')) {
        agentPage = page;
        break;
      }
    }
    if (!agentPage) {
      agentPage = reversedPages.find(p => !p.url().startsWith('devtools://')) || reversedPages[0];
    }
  }

  return { browser, page: agentPage };
}

// Helper: Fast text injection using DOM evaluation
async function injectTextInstant(page, text) {
  return await page.evaluate((msg) => {
    const target =
      document.querySelector('.monaco-editor textarea') ||
      document.querySelector('.editor textarea') ||
      document.querySelector('[role="textbox"]') ||
      document.querySelector('textarea.input-field') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]');

    if (target) {
      target.focus();
      // Insert text quickly mimicking paste
      document.execCommand('insertText', false, msg);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true; // Success
    }
    return false; // Failed to find input
  }, text);
}

// Command: /menu, /start, /help - Show command keyboard
bot.command(['menu', 'start', 'help'], async (ctx) => {
  await ctx.reply('🤖 Antigram Commands Menu\nChoose a command below, or type / to see suggestions.', {
    reply_markup: {
      keyboard: [
        [{ text: '/workspaces' }, { text: '/status' }, { text: '/clear' }],
        [{ text: '/approve' }, { text: '/reject' }],
        [{ text: '/accept' }, { text: '/rejectchanges' }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  });
});

// Command: /status, /screenshot, /ss - Take a screenshot of the IDE
bot.command(['status', 'screenshot', 'ss'], async (ctx) => {
  try {
    await ctx.sendChatAction('upload_photo'); // Show "Uploading photo..." action
    const { page } = await getAgentPage();

    if (!page) {
      return ctx.reply('❌ Could not find an active page to capture.');
    }

    const screenshotBuffer = await page.screenshot({ type: 'png' });
    await ctx.replyWithPhoto({ source: screenshotBuffer, filename: 'status.png' });
  } catch (error) {
    console.error('/status Error:', error);
    ctx.reply(`❌ Error taking screenshot: ${error.message}`);
  }
});

// Command: /clear - Clear the IDE input field
bot.command('clear', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();

    if (!page) {
      return ctx.reply('❌ Could not find an active page.');
    }

    await page.bringToFront();

    const cleared = await page.evaluate(() => {
      // 1. Check Antigravity's Lexical Editor first
      const lexicalEditor = document.querySelector('[data-lexical-editor="true"]');
      if (lexicalEditor) {
        lexicalEditor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        return true;
      }

      const target =
        document.querySelector('.monaco-editor textarea') ||
        document.querySelector('.editor textarea') ||
        document.querySelector('[role="textbox"]') ||
        document.querySelector('textarea.input-field') ||
        document.querySelector('textarea') ||
        document.querySelector('[contenteditable="true"]');

      if (target) {
        target.focus();
        if (typeof target.value !== 'undefined') {
          target.value = ''; // Normal inputs
        } else {
          target.textContent = ''; // Content editable
        }
        // Select all and delete (fallback for certain editors like Monaco)
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        target.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    });

    if (cleared) {
      await ctx.reply('🧹 Input cleared successfully!');
    } else {
      await ctx.reply('⚠️ Could not find an input field to clear.');
    }
  } catch (error) {
    console.error('/clear Error:', error);
    ctx.reply(`❌ Error clearing input: ${error.message}`);
  }
});

// Command: /approve - Quick approve/allow the current permission request
bot.command('approve', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const priorities = ['allow once', 'allow this conversation', 'always run', 'always allow', 'approve', 'allow', 'run command', 'confirm', 'yes', 'accept all', 'accept'];
      for (const keyword of priorities) {
        const btn = allBtns.find(b => b.textContent.trim().toLowerCase() === keyword && b.offsetWidth > 0);
        if (btn) { btn.click(); return btn.textContent.trim(); }
      }
      return null;
    });

    if (result) {
      await ctx.reply(`✅ Clicked "${result}" in IDE.`);
    } else {
      await ctx.reply('⚠️ No permission request found to approve.');
    }
  } catch (error) {
    console.error('/approve Error:', error);
    ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Command: /reject - Reject/deny the current permission request
bot.command('reject', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const priorities = ['reject', 'deny', 'disallow', 'reject all', 'cancel'];
      for (const keyword of priorities) {
        const btn = allBtns.find(b => b.textContent.trim().toLowerCase() === keyword && b.offsetWidth > 0);
        if (btn) { btn.click(); return btn.textContent.trim(); }
      }
      return null;
    });

    if (result) {
      await ctx.reply(`🚫 Clicked "${result}" in IDE.`);
    } else {
      await ctx.reply('⚠️ No permission request found to reject.');
    }
  } catch (error) {
    console.error('/reject Error:', error);
    ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Callback: Handle inline keyboard button presses for permission actions
bot.on('callback_query', async (ctx) => {
  try {
    const action = ctx.callbackQuery.data;

    // Handle permission actions
    if (action && action.startsWith('perm:')) {
      const buttonText = action.replace('perm:', '');
      const { page } = await getAgentPage();
      if (!page) { await ctx.answerCbQuery('❌ IDE not connected'); return; }

      const result = await page.evaluate((targetText) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const btn = allBtns.find(b =>
          b.textContent.trim().toLowerCase() === targetText.toLowerCase() && b.offsetWidth > 0
        );
        if (btn) { btn.click(); return true; }
        return false;
      }, buttonText);

      if (result) {
        await ctx.answerCbQuery(`✅ "${buttonText}" clicked!`);
        try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ Action taken: "${buttonText}"`); } catch (e) { }
      } else {
        await ctx.answerCbQuery(`⚠️ Button "${buttonText}" no longer available`);
      }
    }

    // Handle workspace actions
    if (action && action.startsWith('ws:')) {
      const wsId = action.replace('ws:', '');
      const path = workspaceMap[wsId];
      if (path) {
        const antPath = process.env.ANTIGRAVITY_PATH || '/usr/bin/antigravity';
        require('child_process').exec(`"${antPath}" "${path}"`);
        await ctx.answerCbQuery(`✅ Opening ${path}...`);
        try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ Opened Workspace:\n📂 ${path}`); } catch (e) { }
      } else {
        await ctx.answerCbQuery('⚠️ Workspace not found in cache. Run /workspaces again.');
      }
    }

    // Handle file change actions
    if (action && action.startsWith('fileaction:')) {
      const fileAction = action.replace('fileaction:', '');
      const { page } = await getAgentPage();
      if (!page) { await ctx.answerCbQuery('❌ IDE not connected'); return; }

      const result = await page.evaluate((act) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        if (act === 'accept') {
          const btn = allBtns.find(b => b.className.includes('keep-changes') && b.offsetWidth > 0);
          if (btn) { btn.click(); return 'Accept Changes'; }
        } else if (act === 'reject') {
          const btn = allBtns.find(b => b.className.includes('discard-changes') && b.offsetWidth > 0);
          if (btn) { btn.click(); return 'Reject Changes'; }
        }
        return null;
      }, fileAction);

      if (result) {
        await ctx.answerCbQuery(`✅ ${result}!`);
        try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ ${result}`); } catch (e) { }
      } else {
        await ctx.answerCbQuery('⚠️ No file changes pending');
      }
    }
  } catch (error) {
    console.error('Callback query error:', error);
    await ctx.answerCbQuery('❌ Error processing action').catch(() => { });
  }
});

// Command: /accept - Accept pending file changes
bot.command('accept', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const btn = allBtns.find(b => b.className.includes('keep-changes') && b.offsetWidth > 0);
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (result) {
      await ctx.reply('✅ File changes accepted!');
    } else {
      await ctx.reply('⚠️ No pending file changes to accept.');
    }
  } catch (error) {
    console.error('/accept Error:', error);
    ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Command: /rejectchanges - Reject pending file changes
bot.command('rejectchanges', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const btn = allBtns.find(b => b.className.includes('discard-changes') && b.offsetWidth > 0);
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (result) {
      await ctx.reply('🚫 File changes rejected!');
    } else {
      await ctx.reply('⚠️ No pending file changes to reject.');
    }
  } catch (error) {
    console.error('/rejectchanges Error:', error);
    ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Command: /stop, /cancel - Stop agent generation
bot.command(['stop', 'cancel'], async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const stopBtn = document.querySelector('[data-tooltip-id*="input-send-button-cancel" i]') ||
        document.querySelector('[aria-label*="stop generation" i]') ||
        Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.toLowerCase().includes('stop'));
      if (stopBtn && stopBtn.offsetWidth > 0) { stopBtn.click(); return true; }
      return false;
    });

    if (result) {
      await ctx.reply('🛑 Agent generation forced to stop!');
    } else {
      await ctx.reply('⚠️ No active generation to stop (or button not found).');
    }
  } catch (error) {
    console.error('/stop Error:', error);
    ctx.reply(`❌ Error stopping agent: ${error.message}`);
  }
});

// Command: /reset - Refresh or reset agent context
bot.command('reset', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const newChatBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.toLowerCase().includes('new chat') || btn.getAttribute('aria-label') === 'New Chat') ||
        document.querySelector('[aria-label*="new chat" i]');
      if (newChatBtn && newChatBtn.offsetWidth > 0) {
        newChatBtn.click();
        return true;
      }
      return false;
    });

    if (result) {
      await ctx.reply('🔄 Context reset by clicking "New Chat"!');
    } else {
      await page.reload();
      await ctx.reply('🔄 Workspace preview reloaded to clear context.');
    }
  } catch (error) {
    console.error('/reset Error:', error);
    ctx.reply(`❌ Error resetting context: ${error.message}`);
  }
});

// Global memory map for workspace paths (callback_data has 64-byte limit)
const workspaceMap = {};

// Helper: Get active/most recent workspace folder
function getActiveWorkspace() {
  const pyScript = `
import sqlite3, json, os, urllib.parse
db = sqlite3.connect(os.path.expanduser('~/.config/Antigravity/User/globalStorage/state.vscdb'))
c = db.cursor()
c.execute("SELECT value FROM ItemTable WHERE key='history.recentlyOpenedPathsList'")
res = c.fetchone()
if res:
    try:
        data = json.loads(res[0])
        raw_path = data['entries'][0]['folderUri'].replace('file://', '')
        print(urllib.parse.unquote(raw_path))
    except:
        pass
`;
  return require('child_process').execSync('python3', { input: pyScript }).toString().trim();
}

// Command: /workspaces, /projects - List recent projects/workspaces
bot.command(['workspaces', 'projects'], async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const pyScript = `
import sqlite3, json, os
db = sqlite3.connect(os.path.expanduser('~/.config/Antigravity/User/globalStorage/state.vscdb'))
c = db.cursor()
c.execute("SELECT value FROM ItemTable WHERE key='history.recentlyOpenedPathsList'")
res = c.fetchone()
print(res[0] if res else '{}')
`;
    const out = require('child_process').execSync('python3', { input: pyScript }).toString();
    const data = JSON.parse(out);
    const entries = data.entries || [];

    if (entries.length === 0) {
      return ctx.reply('⚠️ No recent workspaces found.');
    }

    const keyboard = [];
    const maxItems = 10;
    let count = 0;
    for (const entry of entries) {
      if (count >= maxItems) break;
      if (entry.folderUri) {
        let path = entry.folderUri.replace('file://', '');
        path = decodeURIComponent(path);
        const folderName = path.split('/').pop() || path;

        // Generate a random ID for the map to stay within 64 bytes
        const id = Math.random().toString(36).substring(2, 10);
        workspaceMap[id] = path;
        keyboard.push([{ text: `📂 ${folderName}`, callback_data: `ws:${id}` }]);
        count++;
      }
    }

    if (keyboard.length === 0) return ctx.reply('⚠️ No recent folder workspaces found.');

    await ctx.reply('📁 Select a recent workspace to open:', { reply_markup: { inline_keyboard: keyboard } });
  } catch (error) {
    console.error('/workspaces Error:', error);
    ctx.reply(`❌ Error fetching workspaces: ${error.message}`);
  }
});

// Command: /new - Create and open a new project
bot.command('new', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
      return ctx.reply('⚠️ Usage: /new <project_name>\nExample: /new my_awesome_app');
    }

    // Replace non-alphanumeric chars with underscore for safe folder names
    const projectName = args.join('_').replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = require('path');
    const os = require('os');
    const projectPath = path.join(os.homedir(), 'Documents', projectName);

    const fs = require('fs');
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }

    const antPath = process.env.ANTIGRAVITY_PATH || '/usr/bin/antigravity';
    require('child_process').exec(`"${antPath}" "${projectPath}"`); // Opens in Antigravity IDE

    await ctx.reply(`✅ Created and opened new workspace: 📂 ${projectName}\nPath: ${projectPath}`);
  } catch (error) {
    console.error('/new Error:', error);
    ctx.reply(`❌ Error creating workspace: ${error.message}`);
  }
});

// Document & Photo Message Handler (File Uploads)
bot.on(['document', 'photo'], async (ctx) => {
  try {
    const isPhoto = ctx.message.photo !== undefined;
    const fileId = isPhoto
      ? ctx.message.photo[ctx.message.photo.length - 1].file_id // get highest res photo
      : ctx.message.document.file_id;

    const fileName = isPhoto
      ? `image_${Date.now()}.jpg`
      : ctx.message.document.file_name;

    const fileUrl = await ctx.telegram.getFileLink(fileId);

    let targetDir = getActiveWorkspace();
    if (!targetDir) {
      return ctx.reply('⚠️ No active workspace found to upload to.');
    }

    const filePath = require('path').join(targetDir, fileName);
    const msg = await ctx.reply(`⬇️ Downloading ${fileName}...`);

    const fs = require('fs');
    const https = require('https');

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https.get(fileUrl.href, response => {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', err => { fs.unlink(filePath, () => { }); reject(err); });
    });

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Successfully uploaded to workspace:\n<code>${escapeHtml(filePath)}</code>`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Upload Error:', err);
    ctx.reply(`❌ Upload error: ${err.message}`);
  }
});

// Text Message Handler
bot.on('text', async (ctx, next) => {
  const messageText = ctx.message.text;
  if (messageText.startsWith('/')) return next(); // Pass to command handlers
  await handleAgentPrompt(ctx, messageText);
});

// Voice Message Handler (Speech-to-Text via Free Google Speech API)
bot.on('voice', async (ctx) => {
  try {
    const msg = await ctx.reply('🎤 Downloading voice note...');
    const fileId = ctx.message.voice.file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId);

    const fs = require('fs');
    const https = require('https');
    const path = require('path');
    const os = require('os');
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegStatic = require('ffmpeg-static');

    ffmpeg.setFfmpegPath(ffmpegStatic);

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '🎤 Transcribing with Google Speech API...');

    // Download audio temporarily
    const tmpOgg = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
    const tmpFlac = path.join(os.tmpdir(), `voice_${Date.now()}.flac`);

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(tmpOgg);
      https.get(fileUrl.href, response => {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', err => { fs.unlink(tmpOgg, () => { }); reject(err); });
    });

    // Convert OGG to 16kHz mono FLAC for Google Speech API
    await new Promise((resolve, reject) => {
      ffmpeg(tmpOgg)
        .audioFrequency(16000)
        .audioChannels(1)
        .format('flac')
        .on('error', (err) => reject(err))
        .on('end', () => resolve())
        .save(tmpFlac);
    });

    // Free chromium key for Google Speech API
    const googleKey = "AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw";
    const googleUrl = `http://www.google.com/speech-api/v2/recognize?client=chromium&lang=en-US&key=${googleKey}`;

    const fetchFunc = typeof globalThis.fetch === 'function' ? globalThis.fetch : fetch;
    const flacData = fs.readFileSync(tmpFlac);

    const req = await fetchFunc(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/x-flac; rate=16000',
      },
      body: flacData
    });

    const responseText = await req.text();

    // Cleanup temporary files
    try { fs.unlinkSync(tmpOgg); } catch (e) { }
    try { fs.unlinkSync(tmpFlac); } catch (e) { }

    let transcribedText = '';
    // Google V2 api frequently returns multiple line-delimited JSON objects
    const lines = responseText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.result && data.result.length > 0 && data.result[0].alternative) {
          transcribedText = data.result[0].alternative[0].transcript || transcribedText;
        }
      } catch (e) { }
    }

    if (transcribedText) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `🎤 Transcribed:\n"${transcribedText}"`);
      await handleAgentPrompt(ctx, transcribedText);
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Failed to transcribe or empty audio.\nResponse: ${responseText}`);
    }
  } catch (err) {
    console.error('Voice Error:', err);
    ctx.reply(`❌ Voice processing error: ${err.message}`);
  }
});

// Core logic for sending a prompt to the agent and monitoring
async function handleAgentPrompt(ctx, messageText) {
  console.log(`\n📥 Forwarding prompt to IDE: "${messageText}"`);

  try {
    await ctx.sendChatAction('typing'); // Show "Typing..." action
    const { page } = await getAgentPage();

    if (!page) {
      return ctx.reply('❌ Could not find the Launchpad/Agent page.');
    }

    await page.bringToFront();

    let inputFocused = false;
    let isLexical = false;
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
            // clear Lexical Editor safely (Meta+A then Backspace)
            await page.keyboard.down('Meta');
            await page.keyboard.press('a');
            await page.keyboard.up('Meta');
            await page.keyboard.press('Backspace');

            // split lines since Lexical handles returns as shift+enter or new paragraphs
            const lines = messageText.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (i > 0) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
              }
              await page.keyboard.type(lines[i], { delay: 5 });
            }
          } else {
            // Type natively very fast
            await page.keyboard.type(messageText, { delay: 1 });
          }

          inputFocused = true;
          break;
        }
      } catch (e) {
        // Ignore and try next selector
      }
    }

    if (!inputFocused) {
      // Fallback: If no explicit element is found, just type
      await page.keyboard.type(messageText, { delay: 1 });
    }

    // Wait a brief moment for state to settle
    await new Promise(resolve => setTimeout(resolve, 200));

    // 2. Try to click the Send button or Enter
    if (isLexical) {
      let buttonClicked = await page.evaluate(() => {
        const sendBtn = document.querySelector('[data-tooltip-id*="input-send-button" i]');
        if (sendBtn) {
          sendBtn.click();
          return true;
        }
        return false;
      });
      if (!buttonClicked) {
        await page.keyboard.press('Enter');
      }
    } else if (!inputFocused) {
      // Just press Enter for unknown inputs
      await page.keyboard.press('Enter');
    } else {
      let buttonClicked = await page.evaluate(() => {
        const sendBtn =
          document.querySelector('[aria-label*="send" i]') ||
          document.querySelector('[aria-label*="submit" i]') ||
          document.querySelector('.send-button') ||
          document.querySelector('.submit-button') ||
          document.querySelector('button[title*="Send" i]') ||
          document.querySelector('button.codicon-send') ||
          Array.from(document.querySelectorAll('button')).find(btn =>
            btn.textContent.toLowerCase().includes('send') ||
            btn.innerHTML.toLowerCase().includes('send')
          );

        if (sendBtn) {
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (!buttonClicked) {
        // Fallback: Trigger "Enter"
        await page.keyboard.press('Enter');
      }
    }

    // 3. Monitor execution & stream live updates to Telegram
    const statusMsg = await ctx.reply('🚀 Prompt sent! Waiting for agent to start...');

    (async () => {
      try {
        // Helper: check if IDE is still generating
        const isStillGenerating = async () => {
          return await page.evaluate(() => {
            return !!document.querySelector('[data-tooltip-id*="input-send-button-cancel" i]') ||
              !!document.querySelector('[aria-label*="stop generation" i]') ||
              (document.querySelector('[data-tooltip-id*="input-send-button" i]')?.outerHTML.includes('bg-red-500'));
          });
        };

        // Helper: extract the latest agent steps from the DOM
        const getAgentSteps = async () => {
          return await page.evaluate(() => {
            // Find the last "flex flex-col space-y-2" which holds the current turn's steps
            const stepContainers = document.querySelectorAll('.flex.flex-col.space-y-2');
            const lastContainer = stepContainers[stepContainers.length - 1];
            if (!lastContainer) return [];

            const steps = [];
            for (const child of lastContainer.children) {
              const text = child.textContent.trim().replace(/\s+/g, ' ');
              if (!text) continue;

              // Parse step type from the text
              let stepText = '';
              if (text.startsWith('Thought for')) {
                stepText = '🧠 ' + text.split('/*')[0].trim(); // e.g. "Thought for 5s"
              } else if (text.startsWith('Edited')) {
                const fileName = text.replace('Edited', '').split('+')[0].trim();
                stepText = '✏️ Edited ' + fileName;
              } else if (text.startsWith('Created')) {
                const fileName = text.replace('Created', '').split('+')[0].trim();
                stepText = '📄 Created ' + fileName;
              } else if (text.startsWith('Running command')) {
                const cmdMatch = text.match(/\$\s*(.+?)(?:\.xterm|$)/);
                const cmd = cmdMatch ? cmdMatch[1].trim().substring(0, 80) : '';
                stepText = '⚡ Running: ' + (cmd || 'command...');
              } else if (text.startsWith('Ran command')) {
                const cmdMatch = text.match(/\$\s*(.+?)(?:\.xterm|$)/);
                const cmd = cmdMatch ? cmdMatch[1].trim().substring(0, 80) : '';
                const exitMatch = text.match(/Exit code (\d+)/);
                const exitCode = exitMatch ? exitMatch[1] : '?';
                stepText = (exitCode === '0' ? '✅' : '❌') + ' Ran: ' + (cmd || 'command') + ` (exit ${exitCode})`;
              } else if (text.startsWith('Running background')) {
                const cmdMatch = text.match(/\$\s*(.+?)(?:\.xterm|$)/);
                const cmd = cmdMatch ? cmdMatch[1].trim().substring(0, 80) : '';
                stepText = '🔄 Background: ' + (cmd || 'command...');
              } else if (text.startsWith('Searching') || text.startsWith('Reading') || text.startsWith('Viewing')) {
                stepText = '🔍 ' + text.substring(0, 100);
              } else if (text.length < 150) {
                stepText = '📋 ' + text.substring(0, 100);
              } else {
                continue; // Skip long blocks (markdown content, etc.)
              }
              steps.push(stepText);
            }
            return steps;
          });
        };

        // Wait for generation to start (up to 7.5s)
        let tries = 0;
        let didStartGenerating = false;
        while (tries < 30) {
          await new Promise(r => setTimeout(r, 250));
          if (await isStillGenerating()) {
            didStartGenerating = true;
            break;
          }
          tries++;
        }

        if (!didStartGenerating) {
          // Fallback: maybe it was too fast
          await new Promise(r => setTimeout(r, 2000));
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id, statusMsg.message_id, null,
              '✅ Prompt execution complete!'
            );
          } catch (e) { /* Ignore */ }
          return;
        }

        // Now stream live updates while generating
        let lastUpdateText = '';
        let stepCount = 0;

        while (true) {
          await new Promise(r => setTimeout(r, 1500)); // Poll every 1.5s

          const generating = await isStillGenerating().catch(() => false);
          const steps = await getAgentSteps().catch(() => []);

          // Build the status message (plain text - no Markdown to avoid parse errors)
          const header = generating ? '⏳ Agent is working...' : '✅ Execution complete!';

          // Only show last 15 steps to avoid message length issues
          const displaySteps = steps.slice(-15);
          const truncatedNote = steps.length > 15 ? `\n(${steps.length - 15} earlier steps hidden) \n` : '';

          const fullText = header + truncatedNote +
            (displaySteps.length > 0
              ? '\n\n' + displaySteps.map((s, i) => `${i + 1}. ${s} `).join('\n')
              : '');

          // Only update if text changed
          if (fullText !== lastUpdateText) {
            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id, statusMsg.message_id, null,
                fullText
              );
              lastUpdateText = fullText;
            } catch (e) {
              if (!e.message?.includes('message is not modified')) {
                console.error('Edit message error:', e.message);
              }
            }
          }

          if (!generating) break;
          stepCount++;

          // Safety: timeout after 10 minutes
          if (stepCount > 400) {
            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id, statusMsg.message_id, null,
                '⚠️ Execution timed out after 10 minutes.\nUse /ss to see current state.'
              );
            } catch (e) { }
            break;
          }
        }

        // After generation completes, extract and send the agent's response
        await new Promise(r => setTimeout(r, 1000)); // Wait for final render

        try {
          const responseText = await page.evaluate(() => {
            // Find the last step container
            const stepContainers = document.querySelectorAll('.flex.flex-col.space-y-2');
            if (!stepContainers.length) return '';
            const lastContainer = stepContainers[stepContainers.length - 1];

            const steps = Array.from(lastContainer.children);

            // Walk backwards to find the response step
            // Response steps contain <p> tags and are NOT thinking blocks
            let responseStep = null;
            for (let i = steps.length - 1; i >= 0; i--) {
              const step = steps[i];
              const rawText = step.textContent.trim();

              // Skip thinking blocks
              if (rawText.startsWith('Thought for')) continue;

              // Must have paragraphs
              const hasParagraphs = step.querySelectorAll('p').length > 0;
              if (!hasParagraphs) continue;

              // Skip if only .animate-markdown (internal thinking rendered after thought button)
              const animateBlocks = step.querySelectorAll('.animate-markdown');
              if (animateBlocks.length > 0 && step.querySelectorAll('p').length <= animateBlocks.length) continue;

              responseStep = step;
              break;
            }

            if (!responseStep) return '';

            // Extract structured text from the response
            const elements = responseStep.querySelectorAll('p, h1, h2, h3, h4, li, pre, blockquote');
            const texts = [];
            const seen = new Set();

            for (const el of elements) {
              let text = el.textContent.trim();
              if (!text || seen.has(text)) continue;
              seen.add(text);

              // Skip leaked CSS content from style blocks
              if (text.includes('prefers-color-scheme') || text.includes('.markdown-alert')) continue;

              switch (el.tagName) {
                case 'H1': text = '# ' + text; break;
                case 'H2': text = '## ' + text; break;
                case 'H3': text = '### ' + text; break;
                case 'H4': text = '#### ' + text; break;
                case 'LI': text = '• ' + text; break;
                case 'PRE': text = '```\n' + text + '\n```'; break;
                case 'BLOCKQUOTE': text = '> ' + text; break;
              }
              texts.push(text);
            }

            return texts.join('\n\n');
          });

          if (responseText && responseText.length > 10) {
            // Telegram message limit is 4096 chars, split if needed
            const MAX_LEN = 4000;
            const header = '📝 Agent Response:\n\n';

            if (responseText.length <= MAX_LEN - header.length) {
              await ctx.reply(header + responseText);
            } else {
              // Split into chunks
              const chunks = [];
              let remaining = responseText;
              while (remaining.length > 0) {
                if (remaining.length <= MAX_LEN) {
                  chunks.push(remaining);
                  break;
                }
                // Find a good split point (newline near the limit)
                let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
                if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
                chunks.push(remaining.substring(0, splitAt));
                remaining = remaining.substring(splitAt).trim();
              }

              for (let i = 0; i < chunks.length; i++) {
                const chunkHeader = i === 0 ? header : `(continued ${i + 1}/${chunks.length}) \n\n`;
                await ctx.reply(chunkHeader + chunks[i]);
                if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
              }
            }
          }
        } catch (extractErr) {
          console.error('Response extraction error:', extractErr.message);
        }

      } catch (err) {
        console.error('Background generation monitor error:', err);
      }
    })();

  } catch (error) {
    console.error('Prompt handler Error:', error);
    ctx.reply(`❌ Error communicating with IDE: ${error.message} `);
  }
}

// Command: /terminal - Execute standard commands in IDE terminal
bot.command(['terminal', 'cmd'], async (ctx) => {
  try {
    const cmd = ctx.message.text.substring(ctx.message.text.indexOf(' ') + 1);
    if (!cmd || cmd.startsWith('/')) return ctx.reply('⚠️ Usage: /terminal <command>\nExample: /terminal npm run dev');

    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const result = await page.evaluate(() => {
      const terminal = document.querySelector('.xterm-helper-textarea') || document.querySelector('.xterm-accessible-buffer');
      if (terminal) {
        terminal.focus();
        return true;
      }
      return false;
    });

    if (result) {
      await new Promise(r => setTimeout(r, 200));
      await page.keyboard.type(cmd, { delay: 5 });
      await page.keyboard.press('Enter');
      await ctx.reply(`💻 Sent to terminal: \n\`${cmd}\``, { parse_mode: 'Markdown' });
    } else {
      const allTerminals = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm')).length);
      if (allTerminals > 0) {
        // Fallback: click first terminal then type
        await page.evaluate(() => document.querySelector('.xterm').click());
        await new Promise(r => setTimeout(r, 200));
        await page.keyboard.type(cmd, { delay: 5 });
        await page.keyboard.press('Enter');
        await ctx.reply(`💻 Sent to terminal (via fallback):\n\`${cmd}\``, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('⚠️ Terminal not found or not open in IDE. Please open a terminal tray first.');
      }
    }
  } catch (error) {
    console.error('/terminal Error:', error);
    ctx.reply(`❌ Terminal Error: ${error.message}`);
  }
});

// Command: /logs - View current terminal logs
bot.command('logs', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const { page } = await getAgentPage();
    if (!page) return ctx.reply('❌ Could not find the IDE page.');

    const logs = await page.evaluate(() => {
      // xterm rows hold the visible lines
      const terminalRows = Array.from(document.querySelectorAll('.xterm-rows > div'));
      if (terminalRows.length === 0) return null;
      return terminalRows.slice(-35).map(row => row.textContent).join('\n');
    });

    if (logs && logs.trim().length > 0) {
      let text = logs.replace(/\s+$/g, '');
      if (text.length > 3900) text = text.substring(text.length - 3900);
      await ctx.reply(`🖥️ <b>Recent Terminal Logs:</b>\n<pre>${escapeHtml(text)}</pre>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('⚠️ No active terminal output found.');
    }
  } catch (err) {
    console.error('/logs Error:', err);
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

// Helper to escape HTML for Telegram
function escapeHtml(unsafe) {
  return (unsafe || '').toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Command: /list, /ls - List files in workspace
bot.command(['list', 'ls'], async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const args = ctx.message.text.split(' ').slice(1);
    let targetDir = args.join(' ');
    if (!targetDir) {
      targetDir = getActiveWorkspace();
    } else if (!targetDir.startsWith('/')) {
      targetDir = require('path').join(getActiveWorkspace(), targetDir);
    }
    if (!targetDir) return ctx.reply('⚠️ No active workspace found. Provide an absolute path.');

    const fs = require('fs');
    if (!fs.existsSync(targetDir)) return ctx.reply(`❌ Path not found:\n<code>${escapeHtml(targetDir)}</code>`, { parse_mode: 'HTML' });

    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    let output = `📂 <b>Directory:</b>\n<code>${escapeHtml(targetDir)}</code>\n\n`;

    // Filter and truncate
    const displayFiles = files.filter(f => !f.name.startsWith('.git'));
    for (const f of displayFiles.slice(0, 40)) {
      output += f.isDirectory() ? `📁 ${escapeHtml(f.name)}/\n` : `📄 ${escapeHtml(f.name)}\n`;
    }
    if (displayFiles.length > 40) output += `\n... and ${displayFiles.length - 40} more items.`;

    await ctx.reply(output, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('/list Error:', err);
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

// Command: /read, /cat - Read a file
bot.command(['read', 'cat'], async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply('⚠️ Usage: /read <filename>');

    let filePath = args.join(' ');
    if (!filePath.startsWith('/')) {
      filePath = require('path').join(getActiveWorkspace(), filePath);
    }

    const fs = require('fs');
    if (!fs.existsSync(filePath)) return ctx.reply(`❌ File not found:\n<code>${escapeHtml(filePath)}</code>`, { parse_mode: 'HTML' });

    // Don't read huge binary files
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) return ctx.reply('⚠️ File is too large to read ( > 1MB ).');

    const content = fs.readFileSync(filePath, 'utf8');
    const safeName = escapeHtml(require('path').basename(filePath));
    const safeContent = escapeHtml(content);

    if (content.length > 3900) {
      await ctx.reply(`📄 <b>${safeName}</b> (Truncated):\n\n<pre>${escapeHtml(content.substring(0, 3900))}</pre>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`📄 <b>${safeName}</b>:\n\n<pre>${safeContent}</pre>`, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('/read Error:', err);
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

// Command: /download - Download a file to phone
bot.command('download', async (ctx) => {
  try {
    await ctx.sendChatAction('upload_document');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply('⚠️ Usage: /download <filename>');

    let filePath = args.join(' ');
    if (!filePath.startsWith('/')) {
      filePath = require('path').join(getActiveWorkspace(), filePath);
    }

    const fs = require('fs');
    if (!fs.existsSync(filePath)) return ctx.reply(`❌ File not found:\n<code>${escapeHtml(filePath)}</code>`, { parse_mode: 'HTML' });

    const stats = fs.statSync(filePath);
    if (stats.size > 50 * 1024 * 1024) return ctx.reply('⚠️ File is over 50MB telegram bot limit.');

    await ctx.replyWithDocument({ source: filePath, filename: require('path').basename(filePath) });
  } catch (err) {
    console.error('/download Error:', err);
    ctx.reply(`❌ Error downloading: ${err.message}`);
  }
});

// Git Commands
bot.command('commit', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const args = ctx.message.text.substring(ctx.message.text.indexOf(' ') + 1);
    const msg = args || "Auto-commit from Antigram Bot";
    const dir = getActiveWorkspace();
    if (!dir) return ctx.reply('⚠️ No active workspace.');

    const cp = require('child_process');
    cp.execSync('git add .', { cwd: dir });
    const result = cp.execSync(`git commit -m "${msg}"`, { cwd: dir }).toString();
    ctx.reply(`✅ <b>Committed successfully:</b>\n<pre>${escapeHtml(result)}</pre>`, { parse_mode: 'HTML' });
  } catch (err) {
    let msg = err.stdout ? err.stdout.toString() : err.message;
    ctx.reply(`⚠️ Git Commit output:\n<pre>${escapeHtml(msg)}</pre>`, { parse_mode: 'HTML' });
  }
});

bot.command('push', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const dir = getActiveWorkspace();
    if (!dir) return ctx.reply('⚠️ No active workspace.');
    const result = require('child_process').execSync('git push', { cwd: dir }).toString();
    ctx.reply(`🚀 <b>Pushed to remote:</b>\n<pre>${escapeHtml(result || 'Success')}</pre>`, { parse_mode: 'HTML' });
  } catch (err) {
    let msg = err.stderr ? err.stderr.toString() : err.message;
    ctx.reply(`❌ Git Push failed:\n<pre>${escapeHtml(msg)}</pre>`, { parse_mode: 'HTML' });
  }
});

bot.command('diff', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const dir = getActiveWorkspace();
    if (!dir) return ctx.reply('⚠️ No active workspace.');
    let result = require('child_process').execSync('git status -s', { cwd: dir }).toString();
    if (!result.trim()) result = "No changes (working tree clean).";
    ctx.reply(`🐙 <b>Git Status:</b>\n<pre>${escapeHtml(result)}</pre>`, { parse_mode: 'HTML' });
  } catch (err) {
    ctx.reply(`❌ Git Error: ${err.message}`);
  }
});

// Command: /update_antigram - Pull latest bot code from git and restart
bot.command('update_antigram', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const cp = require('child_process');
    const botDir = __dirname;

    // Check if this dir is a git repo
    try {
      cp.execSync('git rev-parse --is-inside-work-tree', { cwd: botDir, stdio: 'pipe' });
    } catch (e) {
      return ctx.reply('❌ This directory is not a Git repository. Cannot auto-update.');
    }

    // Get current version info
    let currentHash = '';
    try { currentHash = cp.execSync('git rev-parse --short HEAD', { cwd: botDir }).toString().trim(); } catch (e) { }

    const msg = await ctx.reply(`🔄 <b>Updating Antigram Bot...</b>\nCurrent version: <code>${currentHash}</code>\n\nPulling latest changes...`, { parse_mode: 'HTML' });

    // Run git pull
    let pullResult = '';
    try {
      pullResult = cp.execSync('git pull', { cwd: botDir }).toString().trim();
    } catch (e) {
      const errMsg = e.stderr ? e.stderr.toString() : e.message;
      return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `❌ <b>Git pull failed:</b>\n<pre>${escapeHtml(errMsg)}</pre>`, { parse_mode: 'HTML' });
    }

    // Check if anything actually changed
    if (pullResult.includes('Already up to date')) {
      return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `✅ <b>Already up to date!</b>\nYou are running the latest version <code>${currentHash}</code>.`, { parse_mode: 'HTML' });
    }

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `📦 <b>Changes pulled!</b>\n<pre>${escapeHtml(pullResult)}</pre>\n\nInstalling updated dependencies...`, { parse_mode: 'HTML' });

    // Install any new dependencies
    try {
      cp.execSync('npm install --omit=dev', { cwd: botDir, stdio: 'pipe' });
    } catch (e) { }

    // Get new version hash
    let newHash = '';
    try { newHash = cp.execSync('git rev-parse --short HEAD', { cwd: botDir }).toString().trim(); } catch (e) { }

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `✅ <b>Update complete!</b>\n${currentHash} → <code>${newHash}</code>\n\n🔄 Restarting bot...`, { parse_mode: 'HTML' });

    // Short delay so message sends before restart
    setTimeout(() => {
      console.log('🔄 Restarting after update...');
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: 'inherit',
        cwd: botDir,
        env: process.env
      });
      child.unref();
      process.exit(0);
    }, 1500);

  } catch (err) {
    console.error('/update_antigram Error:', err);
    ctx.reply(`❌ Update error: ${err.message}`);
  }
});

// --- Background Agent Monitor ---
let lastSeenPermissionCount = 0;
let lastPermissionMsgId = null;
let lastFileChangeMsgId = null;
let wasGenerating = false;

function startBackgroundMonitor() {
  setInterval(async () => {
    try {
      if (!globalBrowser || !globalBrowser.isConnected()) return;

      const { page } = await getAgentPage();
      if (!page) return;

      const state = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const permKeywords = ['allow once', 'allow this conversation', 'always run', 'always allow', 'approve', 'run command', 'allow',
          'confirm', 'yes', 'accept', 'accept all',
          'reject', 'deny', 'disallow', 'reject all', 'cancel'];

        const permissionBtns = allBtns.filter(b => {
          const text = b.textContent.trim().toLowerCase();
          return permKeywords.includes(text) && b.offsetWidth > 0 && b.offsetHeight > 0;
        }).map(b => b.textContent.trim());

        // Get context: what command is requesting permission?
        let context = '';
        const lastPermBtn = allBtns.filter(b => {
          const text = b.textContent.trim().toLowerCase();
          return ['allow once', 'allow this conversation', 'always run', 'always allow', 'approve', 'allow', 'run command'].includes(text) && b.offsetWidth > 0;
        }).pop();

        if (lastPermBtn) {
          let parent = lastPermBtn.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const text = parent.textContent.trim().replace(/\s+/g, ' ');
            if (text.length > 30 && text.length < 500) {
              const cmdMatch = text.match(/\$\s*(.+?)(?:\.xterm|Always|Relocate|$)/);
              if (cmdMatch) context = cmdMatch[1].trim().substring(0, 100);
              break;
            }
            parent = parent.parentElement;
          }
        }

        return { permissionBtns: [...new Set(permissionBtns)], context };
      });

      // Send inline keyboard when new permission buttons appear
      if (state.permissionBtns.length > 0 && state.permissionBtns.length !== lastSeenPermissionCount) {
        const keyboard = [];
        const row1 = [];
        const row2 = [];

        for (const btnText of state.permissionBtns) {
          const lower = btnText.toLowerCase();
          let emoji = '🔘';
          if (['allow once', 'allow this conversation', 'approve', 'allow', 'yes', 'confirm', 'accept', 'accept all'].includes(lower)) emoji = '✅';
          else if (['always run', 'always allow'].includes(lower)) emoji = '🔁';
          else if (['run command'].includes(lower)) emoji = '▶️';
          else if (['reject', 'deny', 'disallow', 'reject all', 'cancel'].includes(lower)) emoji = '❌';

          const button = { text: `${emoji} ${btnText}`, callback_data: `perm:${btnText}` };
          if (['reject', 'deny', 'disallow', 'reject all', 'cancel'].includes(lower)) {
            row2.push(button);
          } else {
            row1.push(button);
          }
        }

        if (row1.length > 0) keyboard.push(row1);
        if (row2.length > 0) keyboard.push(row2);

        const contextMsg = state.context ? `\nCommand: ${state.context}` : '';

        if (lastPermissionMsgId) {
          try { await bot.telegram.deleteMessage(TELEGRAM_USER_ID, lastPermissionMsgId); } catch (e) { }
        }

        try {
          const msg = await bot.telegram.sendMessage(
            TELEGRAM_USER_ID,
            `⚠️ Agent is requesting permission:${contextMsg}\n\nChoose an action:`,
            { reply_markup: { inline_keyboard: keyboard } }
          );
          lastPermissionMsgId = msg.message_id;
        } catch (e) {
          console.error('Monitor msg error:', e.message);
        }
      }

      if (state.permissionBtns.length === 0 && lastSeenPermissionCount > 0) {
        lastPermissionMsgId = null;
      }
      lastSeenPermissionCount = state.permissionBtns.length;

      // --- File Changes Detection ---
      const fileState = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const hasAccept = allBtns.some(b => b.className.includes('keep-changes') && b.offsetWidth > 0);
        const hasReject = allBtns.some(b => b.className.includes('discard-changes') && b.offsetWidth > 0);

        // Try to get edited file info
        let fileInfo = '';
        const editedFilesEl = document.querySelector('[class*="pointer-events-auto"]');
        if (editedFilesEl) {
          const text = editedFilesEl.textContent.trim().replace(/\s+/g, ' ');
          if (text.includes('.js') || text.includes('.ts') || text.includes('.py') || text.includes('.')) {
            fileInfo = text.substring(0, 200);
          }
        }

        return { hasFileChanges: hasAccept || hasReject, hasAccept, hasReject, fileInfo };
      }).catch(() => ({ hasFileChanges: false }));

      if (fileState.hasFileChanges && !lastFileChangeMsgId) {
        const keyboard = [];
        const row = [];
        if (fileState.hasAccept) row.push({ text: '✅ Accept Changes', callback_data: 'fileaction:accept' });
        if (fileState.hasReject) row.push({ text: '❌ Reject Changes', callback_data: 'fileaction:reject' });
        if (row.length > 0) keyboard.push(row);

        try {
          const msg = await bot.telegram.sendMessage(
            TELEGRAM_USER_ID,
            `📝 File changes pending review:\n${fileState.fileInfo ? fileState.fileInfo : 'Use /ss to see details.'}\n\nChoose an action:`,
            { reply_markup: { inline_keyboard: keyboard } }
          );
          lastFileChangeMsgId = msg.message_id;
        } catch (e) {
          console.error('File change msg error:', e.message);
        }
      } else if (!fileState.hasFileChanges && lastFileChangeMsgId) {
        lastFileChangeMsgId = null;
      }

      // --- Agent Proactive Notifications ---
      const isGenerating = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        return allBtns.some(b => b.textContent && b.textContent.toLowerCase().includes('stop generating') && b.offsetWidth > 0);
      }).catch(() => false);

      if (isGenerating && !wasGenerating) {
        wasGenerating = true;
      } else if (!isGenerating && wasGenerating) {
        wasGenerating = false;
        // Send notification that agent finished
        try {
          await bot.telegram.sendMessage(TELEGRAM_USER_ID, '✅ <b>Agent has finished generating!</b> Check /status to review.', { parse_mode: 'HTML' });
        } catch (e) { }
      }

    } catch (e) {
      // Ignore background errors
    }
  }, 2500);
}

// Start bot
console.log('🤖 Telegram IDE Bridge Bot is running...');

bot.telegram.setMyCommands([
  { command: 'menu', description: 'Show command keyboard menu' },
  { command: 'workspaces', description: 'List recent projects/workspaces' },
  { command: 'new', description: 'Create and open a new project' },
  { command: 'terminal', description: 'Type command in active IDE terminal' },
  { command: 'logs', description: 'View current terminal logs' },
  { command: 'list', description: 'List workspace files' },
  { command: 'read', description: 'Read a file content' },
  { command: 'download', description: 'Download file to phone' },
  { command: 'diff', description: 'Check git status' },
  { command: 'commit', description: 'Git commit all files' },
  { command: 'push', description: 'Git push' },
  { command: 'update_antigram', description: 'Pull latest bot update from GitHub & restart' },
  { command: 'status', description: 'Take agent screenshot' },
  { command: 'stop', description: 'Stop agent generation' },
  { command: 'reset', description: 'Reset agent chat context' },
  { command: 'clear', description: 'Clear IDE input field' },
  { command: 'approve', description: 'Approve agent permission request' },
  { command: 'reject', description: 'Reject agent permission request' },
  { command: 'accept', description: 'Accept pending file changes' },
  { command: 'rejectchanges', description: 'Reject pending file changes' }
]).catch(e => console.error('Failed to set commands menu:', e));

bot.launch().then(async () => {
  console.log('👀 Background monitor started...');
  connectToIDE().catch(() => console.log("Will connect when ready..."));
  startBackgroundMonitor();

  // Send startup notification to user
  try {
    const cp = require('child_process');
    let version = '';
    try { version = cp.execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (e) { }
    const versionLine = version ? `\nVersion: <code>${version}</code>` : '';
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const userIds = TELEGRAM_USER_ID.split(',').map(id => id.trim()).filter(Boolean);
    for (const userId of userIds) {
      await bot.telegram.sendMessage(userId,
        `\u{1F7E2} <b>Antigram Bot is online!</b>${versionLine}\nStarted at: <code>${time}</code>\n\nType /status to check the IDE.`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    console.error('Startup notification error:', e.message);
  }
}).catch((err) => {
  console.error('Failed to start bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => {
  if (globalBrowser) globalBrowser.disconnect();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  if (globalBrowser) globalBrowser.disconnect();
  bot.stop('SIGTERM');
});
