const fs = require('fs');
const path = require('path');

const outputFile = 'full_codebase.txt';
const ignoreList = ['node_modules', '.git', '.env', 'package-lock.json', 'bundle.js', 'dist', 'build'];
const extensions = ['.js', '.json', '.ts', '.md'];

function getAllFiles(dirPath, arrayOfFiles) {
    const files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];

    files.forEach(function (file) {
        if (ignoreList.includes(file)) return;
        const fullPath = path.join(dirPath, file);

        if (fs.statSync(fullPath).isDirectory()) {
            arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
        } else {
            if (extensions.includes(path.extname(file))) {
                arrayOfFiles.push(fullPath);
            }
        }
    });

    return arrayOfFiles;
}

const files = getAllFiles(__dirname);
let content = "";

files.forEach(file => {
    const relativePath = path.relative(__dirname, file);
    content += `\n\n--- START OF FILE: ${relativePath} ---\n\n`;
    content += fs.readFileSync(file, 'utf8');
    content += `\n\n--- END OF FILE: ${relativePath} ---\n`;
});

fs.writeFileSync(outputFile, content);
console.log(`Done! Upload ${outputFile} to the chat.`);