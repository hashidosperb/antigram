require('dotenv').config();
const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer-core');

// Constants
const CDP_PORT = process.env.CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const USER_ID = process.env.USER_ID;

if (!BOT_TOKEN || !USER_ID) {
  console.error('Error: Provide BOT_TOKEN and USER_ID in .env file');
  process.exit(1);
}

// Global browser instance for persistent connection
let globalBrowser = null;

// Initialize Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

// Middleware to check specific USER_ID for security
bot.use((ctx, next) => {
  if (ctx.from && ctx.from.id.toString() === USER_ID.toString()) {
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

// Command: /status - Take a screenshot of the IDE
bot.command('status', async (ctx) => {
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

    // 3. Let user know it was sent, then take a confirmation screenshot
    const statusMsg = await ctx.reply('🚀 Vibe sent! Capturing agent response...');
    
    await ctx.sendChatAction('upload_photo');
    // Wait for the UI / AI to start generating response before taking screenshot
    await new Promise(resolve => setTimeout(resolve, 2000)); 

    const screenshotBuffer = await page.screenshot({ type: 'png' });
    
    // Delete the intermediate "Capturing..." message and send the image
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) { /* Ignore delete errors */ }

    await ctx.replyWithPhoto({ source: screenshotBuffer, filename: 'response.png' });

  } catch (error) {
    console.error('Text handler Error:', error);
    ctx.reply(`❌ Error communicating with IDE: ${error.message}`);
  }
});

// --- Background Agent Monitor ---
let lastSeenPermissionBtns = [];
let isGeneratingState = false;

function startBackgroundMonitor() {
  setInterval(async () => {
    try {
      if (!globalBrowser || !globalBrowser.isConnected()) return;

      const { page } = await getAgentPage();
      if (!page) return;

      const state = await page.evaluate(() => {
          // Find buttons by their exact text content
          const allBtns = Array.from(document.querySelectorAll('button'));
          
          // An explicit "Cancel" text button usually means it is currently running an action/generating
          const cancelBtn = allBtns.find(b => b.textContent.trim().toLowerCase() === 'cancel');
          
          const isGenerating = !!cancelBtn;
          
          // Look for permission buttons visually
          const permissionBtns = allBtns.filter(b => {
              const text = b.textContent.trim().toLowerCase();
              return ['approve', 'run command', 'allow', 'review changes', 'always run', 'confirm', 'yes'].includes(text);
          }).map(b => b.textContent.trim());

          return { isGenerating, permissionBtns };
      });

      // Detect state transitions for execution
      if (isGeneratingState && !state.isGenerating) {
          isGeneratingState = false;
          const screenshotBuffer = await page.screenshot({ type: 'png' });
          await bot.telegram.sendPhoto(
            USER_ID, 
            { source: screenshotBuffer, filename: 'done.png' }, 
            { caption: '✅ Execution finished!' }
          ).catch(e => console.log('Monitor screenshot error:', e.message));
      } else if (!isGeneratingState && state.isGenerating) {
          isGeneratingState = true;
      }

      // Check for new permission requests
      for (const btnText of state.permissionBtns) {
          if (!lastSeenPermissionBtns.includes(btnText)) {
              await bot.telegram.sendMessage(
                 USER_ID, 
                 `⚠️ Agent is requesting action: "${btnText}"\nUse /status to see the screen.`
              ).catch(e => console.error("Monitor msg error:", e.message));
          }
      }
      lastSeenPermissionBtns = state.permissionBtns;

    } catch (e) {
      // Ignore background errors (like context destroyed on reload)
    }
  }, 2500); // Check every 2.5 seconds
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
