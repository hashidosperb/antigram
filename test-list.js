const path = require('path');
const fs = require('fs');

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

try {
    let targetDir = getActiveWorkspace();
    console.log("targetDir is:", targetDir);

    if (!targetDir) console.log('⚠️ No active workspace found. Provide an absolute path.');

    if (!fs.existsSync(targetDir)) console.log(`❌ Path not found:\n\`${targetDir}\``);

    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    let output = `📂 *Directory:*\n\`${targetDir}\`\n\n`;

    // Filter and truncate
    const displayFiles = files.filter(f => !f.name.startsWith('.git'));
    for (const f of displayFiles.slice(0, 40)) {
        output += f.isDirectory() ? `📁 ${f.name}/\n` : `📄 ${f.name}\n`;
    }
    if (displayFiles.length > 40) output += `\n... and ${displayFiles.length - 40} more items.`;

    console.log(output);
} catch (err) {
    console.error('/list Error:', err);
}
