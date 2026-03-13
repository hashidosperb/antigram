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
  console.error('Error: Provide TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID in .env file');
  process.exit(1);
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
bot.use((ctx, next) => {
  if (ctx.from && ctx.from.id.toString() === TELEGRAM_USER_ID.toString()) {
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
  for (const t of targets) {
    if (t.url().includes('workbench.html')) {
        try {
            agentPage = await t.page();
            break;
        } catch(e) {}
    }
  }

  // Fallback to legacy loop
  if (!agentPage) {
      const pages = await browser.pages();
      for (const page of pages) {
        const url = page.url().toLowerCase();
        const title = (await page.title()).toLowerCase();
        if (url.includes('agent') || url.includes('launchpad') || title.includes('agent') || title.includes('launchpad')) {
          agentPage = page;
          break;
        }
      }
      if (!agentPage) {
        agentPage = pages.find(p => !p.url().startsWith('devtools://')) || pages[0];
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
      const priorities = ['always run', 'always allow', 'approve', 'allow', 'run command', 'confirm', 'yes', 'accept all', 'accept'];
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
        try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ Action taken: "${buttonText}"`); } catch(e) {}
      } else {
        await ctx.answerCbQuery(`⚠️ Button "${buttonText}" no longer available`);
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
        try { await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ ${result}`); } catch(e) {}
      } else {
        await ctx.answerCbQuery('⚠️ No file changes pending');
      }
    }
  } catch (error) {
    console.error('Callback query error:', error);
    await ctx.answerCbQuery('❌ Error processing action').catch(() => {});
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

// Text Message Handler
bot.on('text', async (ctx) => {
  const messageText = ctx.message.text;
  
  if (messageText.startsWith('/')) return; // Ignore commands

  console.log(`\n📥 Received Telegram prompt: "${messageText}"`);

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
          const truncatedNote = steps.length > 15 ? `\n(${steps.length - 15} earlier steps hidden)\n` : '';
          
          const fullText = header + truncatedNote + 
            (displaySteps.length > 0
              ? '\n\n' + displaySteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
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
            } catch(e) {}
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
              
              switch(el.tagName) {
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
                const chunkHeader = i === 0 ? header : `(continued ${i + 1}/${chunks.length})\n\n`;
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
    console.error('Text handler Error:', error);
    ctx.reply(`❌ Error communicating with IDE: ${error.message}`);
  }
});

// --- Background Agent Monitor ---
let lastSeenPermissionCount = 0;
let lastPermissionMsgId = null;
let lastFileChangeMsgId = null;

function startBackgroundMonitor() {
  setInterval(async () => {
    try {
      if (!globalBrowser || !globalBrowser.isConnected()) return;

      const { page } = await getAgentPage();
      if (!page) return;

      const state = await page.evaluate(() => {
          const allBtns = Array.from(document.querySelectorAll('button'));
          const permKeywords = ['approve', 'run command', 'allow', 'always run', 'always allow',
                                'confirm', 'yes', 'accept', 'accept all',
                                'reject', 'deny', 'disallow', 'reject all'];
          
          const permissionBtns = allBtns.filter(b => {
              const text = b.textContent.trim().toLowerCase();
              return permKeywords.includes(text) && b.offsetWidth > 0 && b.offsetHeight > 0;
          }).map(b => b.textContent.trim());

          // Get context: what command is requesting permission?
          let context = '';
          const lastPermBtn = allBtns.filter(b => {
            const text = b.textContent.trim().toLowerCase();
            return ['always run', 'approve', 'allow', 'run command'].includes(text) && b.offsetWidth > 0;
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
          if (['approve', 'allow', 'yes', 'confirm', 'accept', 'accept all'].includes(lower)) emoji = '✅';
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
          try { await bot.telegram.deleteMessage(TELEGRAM_USER_ID, lastPermissionMsgId); } catch(e) {}
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
          if (text.includes('.js') || text.includes('.ts') || text.includes('.py') || text.includes('.') ) {
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

    } catch (e) {
      // Ignore background errors
    }
  }, 2500);
}

// Start bot
console.log('🤖 Telegram IDE Bridge Bot is running...');
bot.launch().then(() => {
  console.log('👀 Background monitor started...');
  // Initialize connection early for monitor
  connectToIDE().catch(()=>console.log("Will connect when ready..."));
  startBackgroundMonitor();
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
