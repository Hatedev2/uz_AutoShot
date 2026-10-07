const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function printUsage() {
    console.log('Usage: npm run crop:transparent -- [input-directory] [output-directory]');
    console.log('Defaults: shots -> shots-cropped');
}

function collectPngFiles(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collectPngFiles(fullPath, files);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.png') {
            files.push(fullPath);
        }
    }
    return files;
}

function cropTransparentBounds(png) {
    const { width, height, data } = png;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[((y * width + x) << 2) + 3] === 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }

    if (maxX === -1) return null;
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return png;

    const croppedWidth = maxX - minX + 1;
    const croppedHeight = maxY - minY + 1;
    const cropped = new PNG({ width: croppedWidth, height: croppedHeight });
    const rowBytes = croppedWidth << 2;

    for (let y = 0; y < croppedHeight; y++) {
        const sourceOffset = ((minY + y) * width + minX) << 2;
        data.copy(cropped.data, y * rowBytes, sourceOffset, sourceOffset + rowBytes);
    }

    return cropped;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
}

if (args.length > 2) {
    printUsage();
    process.exit(1);
}

const inputDir = path.resolve(args[0] || 'shots');
const outputDir = path.resolve(args[1] || 'shots-cropped');
const relativeOutput = path.relative(inputDir, outputDir);

if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`Input directory does not exist or is not a directory: ${inputDir}`);
    process.exit(1);
}

if (relativeOutput === '' || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) {
    console.error('Output directory must not be the input directory or a directory inside it.');
    process.exit(1);
}

const files = collectPngFiles(inputDir);
let croppedCount = 0;
let unchangedCount = 0;
let emptyCount = 0;
let existingCount = 0;
let errorCount = 0;

for (const file of files) {
    const relativePath = path.relative(inputDir, file);
    const outputPath = path.join(outputDir, relativePath);

    try {
        if (fs.existsSync(outputPath)) {
            existingCount++;
            continue;
        }

        const png = PNG.sync.read(fs.readFileSync(file));
        const result = cropTransparentBounds(png);

        if (result === null) {
            console.warn(`Skipped fully transparent image: ${relativePath}`);
            emptyCount++;
            continue;
        }

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, PNG.sync.write(result), { flag: 'wx' });

        if (result === png) {
            unchangedCount++;
        } else {
            croppedCount++;
            console.log(`${relativePath}: ${png.width}x${png.height} -> ${result.width}x${result.height}`);
        }
    } catch (error) {
        if (error.code === 'EEXIST' && error.path === outputPath) {
            existingCount++;
            continue;
        }
        console.error(`Failed to process ${relativePath}: ${error.message}`);
        errorCount++;
    }
}

console.log(`Done: ${croppedCount} cropped, ${unchangedCount} unchanged, ${emptyCount} fully transparent, ${existingCount} existing skipped, ${errorCount} errors.`);
if (errorCount > 0) process.exitCode = 1;
