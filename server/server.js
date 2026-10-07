// Modified fork: PNG processing, upload acknowledgements, and per-player studio buckets.
const path = require('path');
const fs   = require('fs');
const { PNG } = require('pngjs');

const RESOURCE   = GetCurrentResourceName();
const RES_PATH   = GetResourcePath(RESOURCE);
const OUTPUT_DIR = path.resolve(path.join(RES_PATH, 'shots'));

try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
} catch (err) {
    console.log('^1[uz_AutoShot]^0 Output dir error: ' + err.message);
}

function stripDataUri(b64) {
    if (typeof b64 !== 'string') return b64;
    if (!b64.startsWith('data:')) return b64;
    const comma = b64.indexOf(',');
    return comma === -1 ? b64 : b64.slice(comma + 1);
}

const ACE_RESTRICTED = GetConvar('uz_autoshot_ace_restricted', 'false') === 'true';
const ACE_COMMAND    = GetConvar('uz_autoshot_command', 'shotmaker');
const ACE_NAME       = 'command.' + ACE_COMMAND;

function checkAce(src) {
    if (!ACE_RESTRICTED) return true;
    return IsPlayerAceAllowed(src.toString(), ACE_NAME);
}

// Operates in place on an already-decoded PNG so the image is only decoded /
// encoded once per capture (see the processCapture handler).
// featherRadius: 2 for full-size frames; 1 when the frame was already
// downscaled in the browser (same visual feather at ~half the pixel size).
function removeChromaKey(png, mode, featherRadius) {
    const d = png.data;
    const w = png.width, h = png.height;
    let removed = 0;
    const isMagenta = mode === 'magenta';

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let keyness = 0;

        if (isMagenta) {
            const rOverG = r - g;
            const bOverG = b - g;
            const minOver = rOverG < bOverG ? rOverG : bOverG;
            const primary = r < b ? r : b;
            if (minOver > 0 && primary > 10) {
                // Soft edge: gradual ramp from 0-20 dominance range
                const edgeSoft = minOver < 20 ? minOver / 20 : 1;
                const primarySoft = primary < 40 ? (primary - 10) / 30 : 1;
                keyness = Math.min(1, (rOverG + bOverG) / (r + b + 1)) * edgeSoft * primarySoft;
            }
        } else {
            const gOverR = g - r;
            const gOverB = g - b;
            const minOver = gOverR < gOverB ? gOverR : gOverB;
            if (minOver > 0 && g > 10) {
                const edgeSoft = minOver < 20 ? minOver / 20 : 1;
                const primarySoft = g < 40 ? (g - 10) / 30 : 1;
                keyness = Math.min(1, (gOverR + gOverB) / (g + 1)) * edgeSoft * primarySoft;
            }
        }

        if (keyness > 0) {
            d[i + 3] = (255 * (1 - keyness) + 0.5) | 0;
            // Despill: remove chroma color bleed from RGB
            if (isMagenta) {
                d[i]     = (r - (r - g) * keyness + 0.5) | 0; // pull R toward G
                d[i + 2] = (b - (b - g) * keyness + 0.5) | 0; // pull B toward G
            } else {
                const cap = r > b ? r : b;
                d[i + 1] = (g - (g - cap) * keyness + 0.5) | 0; // pull G toward max(R,B)
            }
            removed++;
        }
    }

    // Two-pass alpha feather: 5x5 box blur on alpha channel for smooth edges
    const RADIUS = featherRadius || 2;
    const KERNEL = (RADIUS * 2 + 1) * (RADIUS * 2 + 1);
    const totalPx = w * h;
    const src = new Uint8Array(totalPx);

    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < totalPx; i++) src[i] = d[(i << 2) + 3];

        for (let y = RADIUS; y < h - RADIUS; y++) {
            for (let x = RADIUS; x < w - RADIUS; x++) {
                const idx = y * w + x;
                const a = src[idx];
                // Skip interior pixels (all neighbors same alpha)
                if ((a === 0 || a === 255) &&
                    src[idx - 1] === a && src[idx + 1] === a &&
                    src[idx - w] === a && src[idx + w] === a) continue;

                let sum = 0;
                for (let ky = -RADIUS; ky <= RADIUS; ky++) {
                    const rowOff = (y + ky) * w + x;
                    for (let kx = -RADIUS; kx <= RADIUS; kx++) {
                        sum += src[rowOff + kx];
                    }
                }
                d[(idx << 2) + 3] = (sum / KERNEL + 0.5) | 0;
            }
        }
    }

    console.log('^2[uz_AutoShot]^0 Chroma key (' + mode + '): ' + removed + '/' + totalPx + ' pixels removed, edges feathered');
}

// Light sharpen on RGB after downscale (3x3 unsharp: center 5, neighbors -1)
function sharpenRGB(png) {
    const dd = png.data, targetW = png.width, targetH = png.height;
    const STRENGTH = 0.3;
    for (let y = 1; y < targetH - 1; y++) {
        for (let x = 1; x < targetW - 1; x++) {
            const ci = (y * targetW + x) << 2;
            // Skip fully transparent pixels
            if (dd[ci + 3] === 0) continue;
            const t = (ci - (targetW << 2));     // top row
            const b = (ci + (targetW << 2));     // bottom row
            for (let c = 0; c < 3; c++) {
                const sharp = 5 * dd[ci + c] - dd[t + c] - dd[b + c] - dd[ci - 4 + c] - dd[ci + 4 + c];
                const blended = dd[ci + c] + (sharp - dd[ci + c]) * STRENGTH;
                dd[ci + c] = blended < 0 ? 0 : blended > 255 ? 255 : (blended + 0.5) | 0;
            }
        }
    }
}

// Center-crops to the target aspect ratio. Doing this BEFORE the chroma key
// means the (per-pixel + blur) keying only runs on pixels that survive the
// final crop — ~44% fewer for a 16:9 frame going to a square thumbnail.
// Returns the same object when the aspect already matches.
function cropToAspect(src, targetW, targetH) {
    const srcAspect = src.width / src.height;
    const dstAspect = targetW / targetH;

    let cropX = 0, cropY = 0, cropW = src.width, cropH = src.height;
    if (srcAspect > dstAspect) {
        cropW = Math.round(src.height * dstAspect);
        cropX = Math.round((src.width - cropW) / 2);
    } else if (srcAspect < dstAspect) {
        cropH = Math.round(src.width / dstAspect);
        cropY = Math.round((src.height - cropH) / 2);
    }
    if (cropW === src.width && cropH === src.height) return src;

    const dst = new PNG({ width: cropW, height: cropH });
    const rowBytes = cropW << 2;
    for (let y = 0; y < cropH; y++) {
        const si = ((cropY + y) * src.width + cropX) << 2;
        src.data.copy(dst.data, y * rowBytes, si, si + rowBytes);
    }
    return dst;
}

// Takes a decoded PNG, returns the same object when no resize is needed.
function resizePNG(src, targetW, targetH, skipSharpen) {
    if (src.width === targetW && src.height === targetH) return src;

    // Center-crop to target aspect ratio first, then resize
    const srcAspect = src.width / src.height;
    const dstAspect = targetW / targetH;

    let cropX = 0, cropY = 0, cropW = src.width, cropH = src.height;
    if (srcAspect > dstAspect) {
        // Source is wider -> crop sides
        cropW = Math.round(src.height * dstAspect);
        cropX = Math.round((src.width - cropW) / 2);
    } else if (srcAspect < dstAspect) {
        // Source is taller -> crop top/bottom
        cropH = Math.round(src.width / dstAspect);
        cropY = Math.round((src.height - cropH) / 2);
    }

    const dst = new PNG({ width: targetW, height: targetH, fill: true });
    const sd = src.data, dd = dst.data;
    const sw = src.width;
    const xRatio = cropW / targetW;
    const yRatio = cropH / targetH;

    // Use area averaging for downscale (sharper), bilinear for upscale
    const isDownscale = cropW > targetW || cropH > targetH;

    if (isDownscale) {
        // Area averaging: each dst pixel = average of all overlapping src pixels
        for (let y = 0; y < targetH; y++) {
            const sy0 = cropY + y * yRatio;
            const sy1 = cropY + (y + 1) * yRatio;
            const iy0 = sy0 | 0;
            const iy1 = Math.min((sy1 | 0) + 1, cropY + cropH);

            for (let x = 0; x < targetW; x++) {
                const sx0 = cropX + x * xRatio;
                const sx1 = cropX + (x + 1) * xRatio;
                const ix0 = sx0 | 0;
                const ix1 = Math.min((sx1 | 0) + 1, cropX + cropW);

                let r = 0, g = 0, b = 0, a = 0, totalW = 0;

                for (let sy = iy0; sy < iy1; sy++) {
                    // Vertical weight: how much of this row overlaps the dst pixel
                    const wy = (sy < sy0 ? 1 - (sy0 - sy) : sy + 1 > sy1 ? sy1 - sy : 1);
                    const rowOff = sy * sw;

                    for (let sx = ix0; sx < ix1; sx++) {
                        // Horizontal weight: how much of this column overlaps
                        const wx = (sx < sx0 ? 1 - (sx0 - sx) : sx + 1 > sx1 ? sx1 - sx : 1);
                        const w = wx * wy;
                        const si = (rowOff + sx) << 2;
                        r += sd[si]     * w;
                        g += sd[si + 1] * w;
                        b += sd[si + 2] * w;
                        a += sd[si + 3] * w;
                        totalW += w;
                    }
                }

                const di = (y * targetW + x) << 2;
                const inv = 1 / totalW;
                dd[di]     = (r * inv + 0.5) | 0;
                dd[di + 1] = (g * inv + 0.5) | 0;
                dd[di + 2] = (b * inv + 0.5) | 0;
                dd[di + 3] = (a * inv + 0.5) | 0;
            }
        }
    } else {
        // Bilinear interpolation for upscale
        const maxCropX = cropX + cropW - 1;
        const maxCropY = cropY + cropH - 1;

        for (let y = 0; y < targetH; y++) {
            const srcY = cropY + y * yRatio;
            const y0 = srcY | 0;
            const y1 = y0 < maxCropY ? y0 + 1 : maxCropY;
            const yf = srcY - y0;
            const yf1 = 1 - yf;
            const rowA = y0 * sw;
            const rowB = y1 * sw;

            for (let x = 0; x < targetW; x++) {
                const srcX = cropX + x * xRatio;
                const x0 = srcX | 0;
                const x1 = x0 < maxCropX ? x0 + 1 : maxCropX;
                const xf = srcX - x0;
                const xf1 = 1 - xf;

                const i00 = (rowA + x0) << 2;
                const i10 = (rowA + x1) << 2;
                const i01 = (rowB + x0) << 2;
                const i11 = (rowB + x1) << 2;
                const di  = (y * targetW + x) << 2;

                const w00 = xf1 * yf1, w10 = xf * yf1, w01 = xf1 * yf, w11 = xf * yf;
                dd[di]     = (sd[i00]     * w00 + sd[i10]     * w10 + sd[i01]     * w01 + sd[i11]     * w11 + 0.5) | 0;
                dd[di + 1] = (sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11 + 0.5) | 0;
                dd[di + 2] = (sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11 + 0.5) | 0;
                dd[di + 3] = (sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11 + 0.5) | 0;
            }
        }
    }

    if (isDownscale && !skipSharpen) sharpenRGB(dst);

    console.log('^2[uz_AutoShot]^0 Crop+Resize: ' + src.width + 'x' + src.height + ' -> ' + cropW + 'x' + cropH + ' -> ' + targetW + 'x' + targetH + (isDownscale ? (skipSharpen ? ' (area avg)' : ' (area avg + sharpen)') : ' (bilinear)'));
    return dst;
}

const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

// The client throttles itself on these acks (Customize.MaxPendingUploads) so
// captures can't pile up faster than the server can process them.
onNet('uz_autoshot:server:processCapture', (payload) => {
    const src = source;
    const seq = payload && typeof payload === 'object' ? payload.seq : undefined;
    handleCapture(src, payload)
        .catch((err) => console.log('^1[uz_AutoShot]^0 Process error: ' + (err && err.message ? err.message : err)))
        .finally(() => {
            if (seq !== undefined) TriggerClientEvent('uz_autoshot:client:captureProcessed', src, seq);
        });
});

// Lets the rest of the server (player sync, other resources) run between the
// heavy pixel stages instead of freezing the event loop for the whole capture.
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

// Output PNGs are small (thumbnails), so cheaper deflate + a single filter
// costs a few KB at most and skips pngjs' default "try all 5 filters, level 9".
const PNG_WRITE_OPTS = { colorType: 6, deflateLevel: 6, filterType: 4 };

async function handleCapture(src, payload) {
    if (!checkAce(src)) {
        console.log('^1[uz_AutoShot]^0 Refused capture: player ' + src + ' lacks ' + ACE_NAME);
        return;
    }
    if (!payload || typeof payload !== 'object') return;

    const xFilename  = typeof payload.filename === 'string' ? payload.filename : '';
    const wantFormat = typeof payload.format === 'string' ? payload.format.toLowerCase() : 'png';
    const wantTransp = payload.transparent === true || payload.transparent === '1' || payload.transparent === 1;
    const chromaKey  = typeof payload.chromaKey === 'string' ? payload.chromaKey.toLowerCase() : 'green';
    const wantWidth  = parseInt(payload.width)  || 0;
    const wantHeight = parseInt(payload.height) || 0;
    const imageData  = payload.imageData;

    if (!xFilename || /[\\/]\.\.(?:[\\/]|$)/.test(xFilename) || path.isAbsolute(xFilename)) {
        console.log('^1[uz_AutoShot]^0 Refused capture: invalid filename: ' + xFilename);
        return;
    }
    if (typeof imageData !== 'string' || imageData.length === 0) {
        console.log('^1[uz_AutoShot]^0 Refused capture: empty image data for ' + xFilename);
        return;
    }
    if (imageData.length > Math.ceil(MAX_PAYLOAD_BYTES * 4 / 3) + 64) {
        console.log('^1[uz_AutoShot]^0 Refused capture: payload too large for ' + xFilename);
        return;
    }

    try {
        let outputData = Buffer.from(stripDataUri(imageData), 'base64');
        if (!outputData || outputData.length === 0) {
            console.log('^1[uz_AutoShot]^0 Refused capture: invalid base64 for ' + xFilename);
            return;
        }

        let ext = wantFormat;

        // Decode once, run every step on the pixel data, encode once. Previously
        // each step re-decoded and re-encoded the full-resolution frame.
        let png = null;
        let dirty = false;

        const wantResize = wantWidth > 0 && wantHeight > 0;
        const MAX_DIM = 4096;
        const clampedW = Math.min(Math.max(wantWidth, 16), MAX_DIM);
        const clampedH = Math.min(Math.max(wantHeight, 16), MAX_DIM);
        // The screenshot comes straight from the game canvas, so CRC checking is wasted work.
        // Async parse inflates on libuv's threadpool instead of blocking the server thread.
        const readPng = () => new Promise((resolve, reject) => {
            new PNG({ checkCRC: false }).parse(outputData, (err, parsed) => err ? reject(err) : resolve(parsed));
        });

        if (wantTransp) {
            try {
                png = await readPng();
                await yieldLoop();
                // Already downscaled by screenshot-basic (BrowserDownscale)? Then skip
                // crop/resize entirely and just key + sharpen at the final size.
                const preScaled = payload.preScaled === true && wantResize
                    && png.width === clampedW && png.height === clampedH;
                let featherRadius = preScaled ? 1 : 2;
                if (wantResize && !preScaled) {
                    png = cropToAspect(png, clampedW, clampedH);
                    // Key at 2x the output size instead of full resolution: a 1600x1600
                    // frame is ~10x more pixels than 512x512 and stalled the server thread.
                    const keyW = clampedW * 2, keyH = clampedH * 2;
                    if (png.width > keyW && png.height > keyH) {
                        await yieldLoop();
                        png = resizePNG(png, keyW, keyH, true);
                        featherRadius = 1;
                    }
                    await yieldLoop();
                }
                removeChromaKey(png, chromaKey, featherRadius);
                if (preScaled) sharpenRGB(png);
                ext = 'png';
                dirty = true;
            } catch (e) {
                png = null;
                console.log('^3[uz_AutoShot]^0 Chroma key skipped: ' + e.message);
            }
        }

        if (wantResize && ext === 'png') {
            try {
                await yieldLoop();
                if (!png) png = await readPng();
                const resized = resizePNG(png, clampedW, clampedH);
                if (resized !== png) { png = resized; dirty = true; }
            } catch (e) {
                console.log('^3[uz_AutoShot]^0 Resize skipped: ' + e.message);
            }
        } else if (wantResize && ext !== 'png') {
            console.log('^3[uz_AutoShot]^0 Resize requires PNG format; skipping for ' + ext);
        }

        if (png && dirty) {
            await yieldLoop();
            outputData = PNG.sync.write(png, PNG_WRITE_OPTS);
        }
        png = null;

        const outputPath = path.resolve(path.join(OUTPUT_DIR, xFilename + '.' + ext));
        if (!outputPath.startsWith(OUTPUT_DIR + path.sep)) {
            console.log('^1[uz_AutoShot]^0 Refused capture: path traversal blocked for ' + xFilename);
            return;
        }

        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.promises.writeFile(outputPath, outputData);

        const sizeKB = Math.round(outputData.length / 1024);
        const label = wantTransp ? 'bg removed' : ext;
        console.log('^2[uz_AutoShot]^0 Saved: ' + xFilename + '.' + ext + ' (' + sizeKB + ' KB, ' + label + ')');
    } catch (err) {
        console.log('^1[uz_AutoShot]^0 Process error: ' + (err && err.message ? err.message : err));
    }
}

// Each player gets a private studio instance (BUCKET_BASE + server id), so
// several people can run captures at the same time without seeing each other.
// The bucket id is computed here, never taken from the client.
const BUCKET_BASE = parseInt(GetConvar('uz_autoshot_bucket_base', '999')) || 999;
const savedBuckets = new Map(); // src -> bucket the player was in before entering the studio

function restoreBucket(src) {
    if (!savedBuckets.has(src)) return;
    const previous = savedBuckets.get(src);
    savedBuckets.delete(src);
    SetPlayerRoutingBucket(src.toString(), previous);
    console.log('^2[uz_AutoShot]^0 Player ' + src + ' -> bucket ' + previous);
}

onNet('uz_autoshot:server:setBucket', () => {
    const src = source;
    if (!checkAce(src)) {
        console.log('^1[uz_AutoShot]^0 Refused setBucket: player ' + src + ' lacks ' + ACE_NAME);
        return;
    }
    const bucket = BUCKET_BASE + parseInt(src);
    // setBucket can be called several times per session: only remember the
    // original bucket the first time, otherwise we'd "restore" into the studio.
    if (!savedBuckets.has(src)) savedBuckets.set(src, GetPlayerRoutingBucket(src.toString()));
    SetPlayerRoutingBucket(src.toString(), bucket);
    SetRoutingBucketPopulationEnabled(bucket, false);
    console.log('^2[uz_AutoShot]^0 Player ' + src + ' -> bucket ' + bucket);
});

onNet('uz_autoshot:server:resetBucket', () => {
    const src = source;
    if (!checkAce(src)) {
        console.log('^1[uz_AutoShot]^0 Refused resetBucket: player ' + src + ' lacks ' + ACE_NAME);
        return;
    }
    if (savedBuckets.has(src)) restoreBucket(src);
    else {
        SetPlayerRoutingBucket(src.toString(), 0);
        console.log('^2[uz_AutoShot]^0 Player ' + src + ' -> bucket 0');
    }
});

on('playerDropped', () => {
    savedBuckets.delete(source);
});
