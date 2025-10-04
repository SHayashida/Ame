// スーパーエンジニアチームによる実装（改）
// 雨がコンクリートのL型街渠を濡らし、熱で乾いていく瞬間を描画するデジタルアート

const canvas = document.getElementById('artCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const CONFIG = {
    rain: {
        baseDensity: 2.4,                // 1フレームあたりの平均生成数（雨強度により変化）
        intensityRampMs: 45000,          // 全面が濡れるまでの雨量上昇時間
        gravityWall: 0.0028,             // 壁面を滑る雨粒の重力加速度
        gravityAir: 0.0042,              // 空中を落ちる雨粒の重力加速度
        wallMaxSpeed: 0.72,
        floorMinSpeed: 0.045,
        wallSpawnWeight: 0.62,
        radiusMin: 3,
        radiusMax: 8,
        maxDroplets: 420
    },
    wetting: {
        depositScale: 0.78,
        cornerBoost: 1.45,
        streakStretch: 2.1,
        floorStretch: 1.6,
        saturationCap: 1.3,
        spreadSamples: 900,
        spreadRate: 0.12
    },
    evaporation: {
        baseRate: 0.000035,
        variance: 0.00008,
        heatPulseAmplitude: 0.00002,
        heatPulsePeriodMs: 16000
    },
    shading: {
        darkening: 0.55,
        coldTint: 0.22,
        specular: 0.45,
        ambientFog: 0.05
    }
};

let displayWidth = 0;
let displayHeight = 0;
let pixelRatio = 1;
let width = 0;
let height = 0;
let totalPixels = 0;

let baseImageData = null;
let outputImageData = null;
let wetMap = null;
let evaporationMap = null;
let absorptionMap = null;
let highlightMap = null;

let animationReady = false;
let lastTimestamp = performance.now();
let rainIntensity = 0;
let rainAccumulator = 0;
let heatPulseTime = 0;
let pendingRebuild = true;

const droplets = [];
const dropletPool = [];

const geometry = {
    wallWidth: 0,
    wallTopOffset: 0,
    floorHeight: 0,
    cornerSoftness: 0,
    cornerX: 0,
    cornerY: 0
};

const textureImage = new Image();
textureImage.src = 'concrete.jpeg';
let textureReady = false;

textureImage.addEventListener('load', () => {
    textureReady = true;
    pendingRebuild = true;
});

textureImage.addEventListener('error', () => {
    console.warn('テクスチャ画像(concrete.jpeg)の読み込みに失敗しました。ノイズベースで描画します。');
    textureReady = false;
    pendingRebuild = true;
});

window.addEventListener('resize', () => {
    pendingRebuild = true;
});

requestAnimationFrame(loop);

function loop(timestamp) {
    if (pendingRebuild) {
        rebuild();
        pendingRebuild = false;
    }

    if (!animationReady) {
        requestAnimationFrame(loop);
        return;
    }

    const delta = Math.min(48, timestamp - lastTimestamp || 16);
    lastTimestamp = timestamp;

    updateSimulation(delta);
    renderFrame();

    requestAnimationFrame(loop);
}

function rebuild() {
    resizeCanvas();
    configureGeometry();
    allocateFields();
    composeBaseTexture(textureReady ? textureImage : null);
    animationReady = Boolean(baseImageData);
    rainIntensity = 0;
    rainAccumulator = 0;
    heatPulseTime = 0;
    droplets.length = 0;
}

function resizeCanvas() {
    displayWidth = window.innerWidth;
    displayHeight = window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    width = Math.max(Math.floor(displayWidth * pixelRatio), 1);
    height = Math.max(Math.floor(displayHeight * pixelRatio), 1);
    totalPixels = width * height;

    canvas.width = width;
    canvas.height = height;
}

function configureGeometry() {
    geometry.wallWidth = Math.floor(width * 0.32);
    geometry.wallTopOffset = Math.floor(height * 0.12);
    geometry.floorHeight = Math.floor(height * 0.66);
    geometry.cornerSoftness = Math.floor(width * 0.06);
    geometry.cornerX = geometry.wallWidth;
    geometry.cornerY = geometry.floorHeight;
}

function allocateFields() {
    wetMap = new Float32Array(totalPixels);
    evaporationMap = new Float32Array(totalPixels);
    absorptionMap = new Float32Array(totalPixels);
    highlightMap = new Float32Array(totalPixels);
    outputImageData = ctx.createImageData(width, height);
}

function composeBaseTexture(image) {
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const offCtx = offscreen.getContext('2d');

    // ベースのコンクリート質感を描画
    if (image) {
        const pattern = offCtx.createPattern(image, 'repeat');
        if (pattern) {
            offCtx.fillStyle = pattern;
            offCtx.fillRect(0, 0, width, height);
        }
    }

    if (!image || offCtx.getImageData(0, 0, 1, 1).data.every(channel => channel === 0)) {
        drawProceduralConcrete(offCtx);
    }

    // L型街渠の壁面と床面を描画
    drawLShapeShading(offCtx);

    baseImageData = offCtx.getImageData(0, 0, width, height);
    buildSupportMaps();
}

function drawProceduralConcrete(context) {
    const baseColor = [82, 84, 88];
    const secondary = [96, 98, 104];
    const noiseStrength = 24;
    const imageData = context.createImageData(width, height);
    const data = imageData.data;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const n = fract(Math.sin((x * 12.9898 + y * 78.233) * 43758.5453) * 43758.5453);
            const mix = Math.pow(n, 1.3);
            data[index] = lerp(baseColor[0], secondary[0], mix) + (n - 0.5) * noiseStrength;
            data[index + 1] = lerp(baseColor[1], secondary[1], mix) + (n - 0.5) * noiseStrength;
            data[index + 2] = lerp(baseColor[2], secondary[2], mix) + (n - 0.5) * noiseStrength;
            data[index + 3] = 255;
        }
    }

    context.putImageData(imageData, 0, 0);
}

function drawLShapeShading(context) {
    const wallPath = new Path2D();
    wallPath.moveTo(0, 0);
    wallPath.lineTo(geometry.wallWidth, geometry.wallTopOffset);
    wallPath.lineTo(geometry.wallWidth, height);
    wallPath.lineTo(0, height);
    wallPath.closePath();

    context.save();
    context.clip(wallPath);
    const wallGradient = context.createLinearGradient(0, 0, geometry.wallWidth * 0.8, height);
    wallGradient.addColorStop(0, 'rgba(220, 225, 235, 0.14)');
    wallGradient.addColorStop(0.28, 'rgba(180, 186, 194, 0.08)');
    wallGradient.addColorStop(1, 'rgba(25, 28, 32, 0.45)');
    context.globalCompositeOperation = 'overlay';
    context.fillStyle = wallGradient;
    context.fillRect(0, 0, geometry.wallWidth + 2, height);
    context.restore();

    const floorPath = new Path2D();
    floorPath.moveTo(geometry.wallWidth, geometry.wallTopOffset);
    floorPath.lineTo(width, geometry.floorHeight - geometry.cornerSoftness);
    floorPath.lineTo(width, height);
    floorPath.lineTo(0, height);
    floorPath.lineTo(0, height - geometry.cornerSoftness * 1.4);
    floorPath.closePath();

    context.save();
    context.clip(floorPath);
    const floorGradient = context.createLinearGradient(geometry.wallWidth, geometry.floorHeight, width, height);
    floorGradient.addColorStop(0, 'rgba(200, 205, 210, 0.16)');
    floorGradient.addColorStop(0.4, 'rgba(80, 82, 86, 0.12)');
    floorGradient.addColorStop(1, 'rgba(15, 18, 22, 0.38)');
    context.globalCompositeOperation = 'overlay';
    context.fillStyle = floorGradient;
    context.fillRect(geometry.wallWidth - geometry.cornerSoftness, geometry.floorHeight - geometry.cornerSoftness * 2, width, height);
    context.restore();

    context.globalCompositeOperation = 'source-over';
    context.lineWidth = Math.max(width * 0.0025, 2);
    context.strokeStyle = 'rgba(255,255,255,0.16)';
    context.beginPath();
    context.moveTo(geometry.wallWidth, geometry.wallTopOffset);
    context.lineTo(geometry.wallWidth, height);
    context.lineTo(width, geometry.floorHeight);
    context.stroke();

    context.strokeStyle = 'rgba(0,0,0,0.45)';
    context.beginPath();
    context.moveTo(geometry.wallWidth, geometry.wallTopOffset + context.lineWidth * 1.2);
    context.lineTo(geometry.wallWidth, height);
    context.lineTo(width, geometry.floorHeight - context.lineWidth * 1.2);
    context.stroke();
}

function buildSupportMaps() {
    const baseData = baseImageData.data;
    for (let y = 0; y < height; y++) {
        const ny = y / Math.max(1, height - 1);
        for (let x = 0; x < width; x++) {
            const nx = x / Math.max(1, width - 1);
            const index = y * width + x;

            const wallInfluence = clamp01(1 - (x / Math.max(1, geometry.wallWidth + geometry.cornerSoftness)));
            const floorInfluence = clamp01((y - geometry.floorHeight + geometry.cornerSoftness * nx) / Math.max(1, height - geometry.floorHeight + geometry.cornerSoftness));

            const cornerDistance = Math.hypot(x - geometry.cornerX, y - geometry.cornerY);
            const cornerHighlight = clamp01(1 - cornerDistance / (Math.min(width, height) * 0.9));

            const wallSpec = wallInfluence * (0.45 + 0.25 * (1 - ny));
            const floorSpec = floorInfluence * (0.28 + 0.2 * nx);
            highlightMap[index] = clamp01(cornerHighlight * 0.45 + wallSpec + floorSpec + CONFIG.shading.ambientFog);

            const absorptionWall = 0.38 + wallInfluence * 0.45;
            const absorptionFloor = 0.52 + floorInfluence * 0.55;
            const aggregateAbsorption = lerp(absorptionWall, absorptionFloor, smoothStep(0, 1, floorInfluence));
            absorptionMap[index] = aggregateAbsorption;

            const evaporationBias = CONFIG.evaporation.baseRate + CONFIG.evaporation.variance * (0.35 + 0.65 * (1 - floorInfluence) + 0.45 * wallInfluence);
            const noise = (baseData[index * 4] + baseData[index * 4 + 1] + baseData[index * 4 + 2]) / (255 * 3);
            evaporationMap[index] = evaporationBias * (0.75 + noise * 0.5);
        }
    }
}

function updateSimulation(delta) {
    accelerateRainIntensity(delta);
    spawnRain(delta);
    updateDroplets(delta);
    evaporate(delta);
    capillaryFlow();
}

function accelerateRainIntensity(delta) {
    rainIntensity = clamp01(rainIntensity + delta / CONFIG.rain.intensityRampMs);
}

function spawnRain(delta) {
    const targetDrops = CONFIG.rain.baseDensity * rainIntensity * delta;
    rainAccumulator += targetDrops;
    const spawnCount = Math.floor(rainAccumulator);
    rainAccumulator -= spawnCount;

    for (let i = 0; i < spawnCount; i++) {
        if (droplets.length >= CONFIG.rain.maxDroplets) break;
        const spawnWall = Math.random() < CONFIG.rain.wallSpawnWeight;
        const droplet = dropletPool.pop() || {};
        initializeDroplet(droplet, spawnWall ? 'wall' : 'floor');
        droplets.push(droplet);
    }
}

function initializeDroplet(droplet, surface) {
    droplet.surface = surface;
    droplet.radius = randomRange(CONFIG.rain.radiusMin, CONFIG.rain.radiusMax) * pixelRatio;
    droplet.strength = randomRange(0.6, 1.2);
    droplet.life = randomRange(1200, 3400);
    droplet.vx = 0;
    droplet.vy = 0;
    droplet.hasSplashed = false;

    if (surface === 'wall') {
        droplet.x = randomRange(geometry.wallWidth * 0.18, geometry.wallWidth * 0.92);
        droplet.y = -randomRange(0, height * 0.08);
        droplet.vy = randomRange(0.18, 0.35) * pixelRatio;
        droplet.vx = randomRange(-0.08, 0.08) * pixelRatio;
    } else {
        droplet.x = randomRange(geometry.wallWidth * 0.9, width - width * 0.05);
        droplet.y = -randomRange(0, height * 0.12);
        droplet.vy = randomRange(0.55, 0.75) * pixelRatio;
        droplet.vx = randomRange(-0.2, 0.12) * pixelRatio;
    }
}

function updateDroplets(delta) {
    for (let i = droplets.length - 1; i >= 0; i--) {
        const droplet = droplets[i];
        droplet.life -= delta;

        if (droplet.surface === 'wall') {
            updateWallDroplet(droplet, delta);
        } else {
            updateFloorDroplet(droplet, delta);
        }

        if (
            droplet.life <= 0 ||
            droplet.y > height + 20 ||
            droplet.x < -40 || droplet.x > width + 40
        ) {
            if (!droplet.hasSplashed && droplet.surface === 'floor') {
                splashAt(droplet.x, droplet.y, droplet.radius * 1.4, droplet.strength * 1.2, CONFIG.wetting.floorStretch, 1.05);
            }
            droplets.splice(i, 1);
            dropletPool.push(droplet);
        }
    }
}

function updateWallDroplet(droplet, delta) {
    droplet.vy = Math.min(droplet.vy + CONFIG.rain.gravityWall * delta, CONFIG.rain.wallMaxSpeed);
    droplet.x += droplet.vx * delta;
    droplet.y += droplet.vy * delta;
    droplet.vx *= 0.955;

    if (droplet.y >= geometry.wallTopOffset) {
        droplet.vx += (Math.random() - 0.5) * 0.012 * pixelRatio;
    }

    sprinkleStreak(droplet.x, droplet.y, droplet.radius, droplet.strength);

    const handoffLine = geometry.floorHeight - geometry.cornerSoftness * 0.6;
    if (droplet.y >= handoffLine) {
        droplet.surface = 'floor';
        droplet.y = handoffLine + droplet.radius * 0.6;
        droplet.vx = Math.max(droplet.vx, randomRange(0.15, 0.45) * pixelRatio);
        droplet.vy = randomRange(CONFIG.rain.floorMinSpeed, CONFIG.rain.floorMinSpeed * 1.8);
        droplet.radius *= randomRange(1.08, 1.26);
        splashAt(droplet.x, droplet.y + droplet.radius * 0.5, droplet.radius * 1.3, droplet.strength * 1.3, CONFIG.wetting.floorStretch, 0.9);
        droplet.hasSplashed = true;
    }
}

function updateFloorDroplet(droplet, delta) {
    droplet.vy = Math.max(droplet.vy - 0.0008 * delta, CONFIG.rain.floorMinSpeed);
    droplet.x += droplet.vx * delta;
    droplet.y += droplet.vy * delta;
    droplet.vx *= 0.985;
    droplet.vx += (Math.random() - 0.5) * 0.0009 * delta * pixelRatio;

    sprinkleFlow(droplet.x, droplet.y, droplet.radius, droplet.strength);
}

function sprinkleStreak(x, y, radius, strength) {
    splashAt(x, y, radius * 0.9, strength * 0.42, 0.6, CONFIG.wetting.streakStretch);
    splashAt(x + radius * 0.3, y + radius * 0.4, radius * 0.6, strength * 0.25, 0.75, CONFIG.wetting.streakStretch * 1.2);
}

function sprinkleFlow(x, y, radius, strength) {
    splashAt(x, y, radius, strength * 0.55, CONFIG.wetting.floorStretch, 1);
    splashAt(x - radius * 0.8, y - radius * 1.2, radius * 0.5, strength * 0.22, CONFIG.wetting.floorStretch * 1.4, 0.6);
}

function splashAt(cx, cy, radius, intensity, stretchX, stretchY) {
    if (!radius || intensity <= 0) return;
    if (cx < -radius || cy < -radius || cx > width + radius || cy > height + radius) return;

    const sx = stretchX || 1;
    const sy = stretchY || 1;
    const minX = Math.max(0, Math.floor(cx - radius * sx));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius * sx));
    const minY = Math.max(0, Math.floor(cy - radius * sy));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius * sy));

    for (let y = minY; y <= maxY; y++) {
        const dy = (y - cy) / (radius * sy);
        for (let x = minX; x <= maxX; x++) {
            const dx = (x - cx) / (radius * sx);
            const distSq = dx * dx + dy * dy;
            if (distSq > 1) continue;

            const index = y * width + x;
            const falloff = (1 - Math.sqrt(distSq)) * intensity * CONFIG.wetting.depositScale;
            const absorption = absorptionMap[index] * (1 + highlightMap[index] * 0.25);
            const boost = cornerBoostFactor(x, y);
            wetMap[index] = Math.min(CONFIG.wetting.saturationCap, wetMap[index] + falloff * absorption * boost);
        }
    }
}

function cornerBoostFactor(x, y) {
    const dx = x - geometry.cornerX;
    const dy = y - geometry.cornerY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    return 1 + CONFIG.wetting.cornerBoost * Math.pow(Math.max(0, 1 - dist / (Math.min(width, height) * 0.55)), 2.6);
}

function evaporate(delta) {
    heatPulseTime += delta;
    const heatPulse = CONFIG.evaporation.heatPulseAmplitude * (Math.sin((heatPulseTime % CONFIG.evaporation.heatPulsePeriodMs) / CONFIG.evaporation.heatPulsePeriodMs * Math.PI * 2) * 0.5 + 0.5);

    for (let i = 0; i < totalPixels; i++) {
        const loss = (evaporationMap[i] + heatPulse) * delta;
        wetMap[i] = Math.max(0, wetMap[i] - loss);
    }
}

function capillaryFlow() {
    const iterations = Math.floor(CONFIG.wetting.spreadSamples * rainIntensity);
    if (iterations < 1) return;

    for (let i = 0; i < iterations; i++) {
        const index = Math.floor(Math.random() * totalPixels);
        const wetness = wetMap[index];
        if (wetness < 0.12) continue;

        const neighborIndex = randomNeighbor(index);
        if (neighborIndex === null) continue;

        const diff = wetness - wetMap[neighborIndex];
        if (diff <= 0) continue;

        const transfer = diff * (0.12 + CONFIG.wetting.spreadRate * Math.random());
        wetMap[index] -= transfer;
        wetMap[neighborIndex] = Math.min(CONFIG.wetting.saturationCap, wetMap[neighborIndex] + transfer * 0.94);
    }
}

function randomNeighbor(index) {
    const x = index % width;
    const y = Math.floor(index / width);
    const choices = [];
    if (x > 0) choices.push(index - 1);
    if (x < width - 1) choices.push(index + 1);
    if (y > 0) choices.push(index - width);
    if (y < height - 1) choices.push(index + width);
    if (choices.length === 0) return null;
    return choices[Math.floor(Math.random() * choices.length)];
}

function renderFrame() {
    if (!baseImageData) return;

    const baseData = baseImageData.data;
    const outputData = outputImageData.data;

    for (let i = 0; i < totalPixels; i++) {
        const wetness = clamp01(wetMap[i]);
        const baseIndex = i * 4;
        const highlight = highlightMap[i] * wetness * CONFIG.shading.specular;

        let r = baseData[baseIndex];
        let g = baseData[baseIndex + 1];
        let b = baseData[baseIndex + 2];
        const a = baseData[baseIndex + 3];

        const darken = 1 - wetness * CONFIG.shading.darkening;
        r *= darken;
        g *= darken * (1 - wetness * 0.08);
        b *= darken * (1 - wetness * 0.18);

        const tint = wetness * CONFIG.shading.coldTint;
        r -= tint * 22;
        g -= tint * 10;
        b += tint * 48;

        r += highlight * 110;
        g += highlight * 145;
        b += highlight * 175;

        outputData[baseIndex] = clamp255(r);
        outputData[baseIndex + 1] = clamp255(g);
        outputData[baseIndex + 2] = clamp255(b);
        outputData[baseIndex + 3] = a;
    }

    ctx.putImageData(outputImageData, 0, 0);
}

// ---- Utility functions --------------------------------------------------

function clamp01(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp255(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function smoothStep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function randomRange(min, max) {
    return Math.random() * (max - min) + min;
}

function fract(value) {
    return value - Math.floor(value);
}