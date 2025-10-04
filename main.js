// Top-down rainfall simulation on a concrete slab
// 雨粒が上空から落下し、コンクリート面に染み込み、蒸発していく様子を描画する

const canvas = document.getElementById('artCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const CONFIG = {
	rain: {
		baseDensity: 1.8,
		intensityRampMs: 48000,
		maxDroplets: 420,
		spawnHeightMin: 0.06,
		spawnHeightMax: 0.2,
		radiusMin: 2.2,
		radiusMax: 5.2,
		initialSpeedMin: 0.16,
		initialSpeedMax: 0.28,
		gravity: 0.0032,
		windVariance: 0.0003
	},
	wetting: {
		depositScale: 0.92,
		saturationCap: 1.4,
		diffusionSamples: 1400,
		diffusionRate: 0.18,
		diffusionThreshold: 0.08,
		microChannelStrength: 0.35,
		ringFalloff: 0.55
	},
	evaporation: {
		baseRate: 0.00002,
		variance: 0.00005,
		heatPulseAmplitude: 0.000012,
		heatPulsePeriodMs: 32000
	},
	shading: {
		darkening: 0.58,
		coldTint: 0.18,
		specular: 0.55,
		ambientLift: 0.08,
		edgeDarken: 0.22
	},
	overlay: {
		dropletAlpha: 0.42,
		tailMaxRatio: 0.14,
		flashLifeMs: 520
	}
};

const FLOW = {
	drainX: 0.78,
	drainY: 0.84,
	bias: 0.55
};

let displayWidth = 0;
let displayHeight = 0;
let pixelRatio = 1;
let width = 1;
let height = 1;
let fallScale = 1;
let totalPixels = 0;

let baseImageData = null;
let outputImageData = null;
let wetMap = null;
let evaporationMap = null;
let absorptionMap = null;
let highlightMap = null;

let animationReady = false;
let pendingRebuild = true;
let textureReady = false;

let lastTimestamp = performance.now();
let rainIntensity = 0;
let rainAccumulator = 0;
let heatPulseTime = 0;

const droplets = [];
const dropletPool = [];
const impactFlashes = [];

const textureImage = new Image();
textureImage.src = 'concrete.jpeg';
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
	allocateFields();
	composeBaseTexture(textureReady ? textureImage : null);

	animationReady = Boolean(baseImageData);
	rainIntensity = 0;
	rainAccumulator = 0;
	heatPulseTime = 0;
	droplets.length = 0;
	impactFlashes.length = 0;
}

function resizeCanvas() {
	displayWidth = window.innerWidth;
	displayHeight = window.innerHeight;
	pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

	canvas.style.width = `${displayWidth}px`;
	canvas.style.height = `${displayHeight}px`;

	width = Math.max(Math.floor(displayWidth * pixelRatio), 1);
	height = Math.max(Math.floor(displayHeight * pixelRatio), 1);
	fallScale = Math.max(width, height);
	totalPixels = width * height;

	canvas.width = width;
	canvas.height = height;
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

	paintBaseConcrete(offCtx);

	if (image && image.width > 0 && image.height > 0) {
		const scale = Math.max(width / image.width, height / image.height);
		const drawWidth = image.width * scale;
		const drawHeight = image.height * scale;
		const offsetX = (width - drawWidth) / 2;
		const offsetY = (height - drawHeight) / 2;
		offCtx.save();
		offCtx.globalAlpha = 0.72;
		offCtx.globalCompositeOperation = 'overlay';
		offCtx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
		offCtx.restore();
	}

	applyConcreteNoise(offCtx);
	drawCracks(offCtx);
	drawEdgeVignette(offCtx);

	baseImageData = offCtx.getImageData(0, 0, width, height);
	outputImageData = ctx.createImageData(width, height);

	buildSupportMaps();
}

function paintBaseConcrete(context) {
	const gradient = context.createLinearGradient(0, 0, width * 0.6, height * 0.8);
	gradient.addColorStop(0, '#6d7076');
	gradient.addColorStop(1, '#4a4d52');
	context.fillStyle = gradient;
	context.fillRect(0, 0, width, height);
}

function applyConcreteNoise(context) {
	const imageData = context.getImageData(0, 0, width, height);
	const data = imageData.data;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			const grain = (hash(x * 0.9, y * 1.1) - 0.5) * 32;
			const shade = (hash(y * 1.7, x * 0.6) - 0.5) * 24;
			data[idx] = clamp255(data[idx] + grain + shade * 0.6);
			data[idx + 1] = clamp255(data[idx + 1] + grain * 0.9 + shade * 0.5);
			data[idx + 2] = clamp255(data[idx + 2] + grain * 0.8 - shade * 0.35);
		}
	}

	context.putImageData(imageData, 0, 0);
}

function drawCracks(context) {
	context.save();
	context.lineWidth = Math.max(1, fallScale * 0.0012);
	context.strokeStyle = 'rgba(18, 20, 24, 0.35)';
	context.globalCompositeOperation = 'multiply';
	const crackCount = Math.floor(18 + Math.sqrt(fallScale) * 0.12);
	for (let i = 0; i < crackCount; i++) {
		const length = randomRange(fallScale * 0.18, fallScale * 0.42);
		let x = randomRange(width * 0.08, width * 0.92);
		let y = randomRange(height * 0.08, height * 0.92);
		context.beginPath();
		context.moveTo(x, y);
		let angle = randomRange(0, Math.PI * 2);
		const segments = 5 + Math.floor(Math.random() * 6);
		for (let s = 0; s < segments; s++) {
			angle += randomRange(-Math.PI / 12, Math.PI / 12);
			x += Math.cos(angle) * (length / segments);
			y += Math.sin(angle) * (length / segments);
			context.lineTo(x, y);
		}
		context.stroke();
	}
	context.restore();
}

function drawEdgeVignette(context) {
	context.save();
	const radial = context.createRadialGradient(
		width * 0.5,
		height * 0.5,
		fallScale * 0.05,
		width * 0.5,
		height * 0.5,
		fallScale * 0.7
	);
	radial.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
	radial.addColorStop(0.45, 'rgba(200, 205, 210, 0.02)');
	radial.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
	context.globalCompositeOperation = 'overlay';
	context.fillStyle = radial;
	context.fillRect(0, 0, width, height);
	context.restore();
}

function buildSupportMaps() {
	const baseData = baseImageData.data;
	const centerX = width * 0.5;
	const centerY = height * 0.5;
	const drainX = width * FLOW.drainX;
	const drainY = height * FLOW.drainY;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			const nx = (x + 0.5) / width;
			const ny = (y + 0.5) / height;
			const edge = Math.max(Math.abs(nx - 0.5), Math.abs(ny - 0.5));
			const radial = Math.hypot(x - centerX, y - centerY) / fallScale;
			const tonal = (baseData[index * 4] + baseData[index * 4 + 1] + baseData[index * 4 + 2]) / (255 * 3);
			const microChannel = Math.abs(Math.sin(x * 0.015) + Math.cos(y * 0.02));
			const slope = Math.hypot(drainX - x, drainY - y) / fallScale;

			highlightMap[index] = clamp01(
				CONFIG.shading.ambientLift +
				(1 - edge) * 0.35 +
				(1 - radial * 1.2) * 0.28 +
				tonal * 0.18
			);

			absorptionMap[index] = (0.55 + tonal * 0.35 + microChannel * CONFIG.wetting.microChannelStrength) *
				(0.9 + (1 - edge) * 0.25);

			const baseEvap = CONFIG.evaporation.baseRate +
				CONFIG.evaporation.variance * (0.3 + tonal * 0.7);
			const bias = CONFIG.evaporation.baseRate * (edge * CONFIG.shading.edgeDarken + slope * 0.55);
			evaporationMap[index] = (baseEvap + bias) * 0.55;
		}
	}
}

function updateSimulation(delta) {
	accelerateRainIntensity(delta);
	spawnDroplets(delta);
	updateDroplets(delta);
	evaporate(delta);
	diffuseWetness();
	updateImpactFlashes(delta);
}

function accelerateRainIntensity(delta) {
	rainIntensity = clamp01(rainIntensity + delta / CONFIG.rain.intensityRampMs);
}

function spawnDroplets(delta) {
	const targetDrops = CONFIG.rain.baseDensity * rainIntensity * delta;
	rainAccumulator += targetDrops;
	const spawnCount = Math.floor(rainAccumulator);
	rainAccumulator -= spawnCount;

	for (let i = 0; i < spawnCount; i++) {
		if (droplets.length >= CONFIG.rain.maxDroplets) break;
		const droplet = dropletPool.pop() || {};
		initialiseDroplet(droplet);
		droplets.push(droplet);
	}
}

function initialiseDroplet(droplet) {
	const spawnPaddingX = width * 0.05;
	const spawnPaddingY = height * 0.05;
	droplet.x = randomRange(spawnPaddingX, width - spawnPaddingX);
	droplet.y = randomRange(spawnPaddingY, height - spawnPaddingY);
	droplet.height = randomRange(CONFIG.rain.spawnHeightMin, CONFIG.rain.spawnHeightMax) * fallScale;
	droplet.radius = randomRange(CONFIG.rain.radiusMin, CONFIG.rain.radiusMax) * pixelRatio;
	droplet.strength = randomRange(0.65, 1.25);
	droplet.vz = randomRange(CONFIG.rain.initialSpeedMin, CONFIG.rain.initialSpeedMax) * fallScale;
	droplet.windX = (Math.random() - 0.5) * CONFIG.rain.windVariance * width;
	droplet.windY = (Math.random() - 0.5) * CONFIG.rain.windVariance * height;
}

function updateDroplets(delta) {
	for (let i = droplets.length - 1; i >= 0; i--) {
		const droplet = droplets[i];
		droplet.x += droplet.windX * delta;
		droplet.y += droplet.windY * delta;
		droplet.vz += CONFIG.rain.gravity * fallScale * delta;
		droplet.height -= droplet.vz * delta;

		if (
			droplet.x < -20 || droplet.x > width + 20 ||
			droplet.y < -20 || droplet.y > height + 20
		) {
			droplets.splice(i, 1);
			dropletPool.push(droplet);
			continue;
		}

		if (droplet.height <= 0) {
			const hitX = clamp(droplet.x, 0, width - 1);
			const hitY = clamp(droplet.y, 0, height - 1);
			const splashRadius = droplet.radius * randomRange(2.6, 3.4);
			splashAt(hitX, hitY, splashRadius, droplet.strength);
			impactFlashes.push({
				x: hitX,
				y: hitY,
				radius: splashRadius * 2.4,
				strength: clamp01(droplet.strength),
				life: CONFIG.overlay.flashLifeMs
			});
			droplets.splice(i, 1);
			dropletPool.push(droplet);
		}
	}
}

function splashAt(cx, cy, radius, strength) {
	if (radius <= 0 || strength <= 0) return;

	const minX = Math.max(0, Math.floor(cx - radius));
	const maxX = Math.min(width - 1, Math.ceil(cx + radius));
	const minY = Math.max(0, Math.floor(cy - radius));
	const maxY = Math.min(height - 1, Math.ceil(cy + radius));

	for (let y = minY; y <= maxY; y++) {
		const dy = (y - cy) / radius;
		for (let x = minX; x <= maxX; x++) {
			const dx = (x - cx) / radius;
			const distSq = dx * dx + dy * dy;
			if (distSq > 1) continue;

			const index = y * width + x;
			const distance = Math.sqrt(distSq);
			const ring = Math.pow(distance, CONFIG.wetting.ringFalloff);
			const deposit = (1 - distance) * (0.7 + (1 - ring) * 0.3);
			const absorption = absorptionMap[index];
			wetMap[index] = Math.min(
				CONFIG.wetting.saturationCap,
				wetMap[index] + deposit * strength * CONFIG.wetting.depositScale * absorption
			);
		}
	}
}

function evaporate(delta) {
	heatPulseTime += delta;
	const phase = (heatPulseTime % CONFIG.evaporation.heatPulsePeriodMs) / CONFIG.evaporation.heatPulsePeriodMs;
	const heatPulse = CONFIG.evaporation.heatPulseAmplitude * (Math.sin(phase * Math.PI * 2) * 0.5 + 0.5);

	for (let i = 0; i < totalPixels; i++) {
		const loss = (evaporationMap[i] + heatPulse) * delta;
		wetMap[i] = Math.max(0, wetMap[i] - loss);
	}
}

function diffuseWetness() {
	const iterations = Math.floor(CONFIG.wetting.diffusionSamples * rainIntensity);
	if (iterations < 1) return;

	for (let i = 0; i < iterations; i++) {
		const index = Math.floor(Math.random() * totalPixels);
		const wetness = wetMap[index];
		if (wetness < CONFIG.wetting.diffusionThreshold) continue;

		const neighborIndex = biasedNeighbor(index);
		if (neighborIndex === index) continue;

		const diff = wetness - wetMap[neighborIndex];
		if (diff <= 0) continue;

		const transfer = diff * (0.08 + CONFIG.wetting.diffusionRate * Math.random());
		wetMap[index] -= transfer;
		wetMap[neighborIndex] = Math.min(CONFIG.wetting.saturationCap, wetMap[neighborIndex] + transfer * 0.96);
	}
}

function biasedNeighbor(index) {
	const x = index % width;
	const y = Math.floor(index / width);
	const neighbors = [];

	if (x > 0) neighbors.push({ index: index - 1, vx: -1, vy: 0 });
	if (x < width - 1) neighbors.push({ index: index + 1, vx: 1, vy: 0 });
	if (y > 0) neighbors.push({ index: index - width, vx: 0, vy: -1 });
	if (y < height - 1) neighbors.push({ index: index + width, vx: 0, vy: 1 });

	if (neighbors.length === 0) return index;

	const targetX = width * FLOW.drainX;
	const targetY = height * FLOW.drainY;
	const dirX = targetX - x;
	const dirY = targetY - y;
	const len = Math.hypot(dirX, dirY) || 1;
	const nx = dirX / len;
	const ny = dirY / len;

	let totalWeight = 0;
	for (const neighbor of neighbors) {
		const dot = neighbor.vx * nx + neighbor.vy * ny;
		neighbor.weight = 0.25 + Math.max(0, dot) * FLOW.bias;
		totalWeight += neighbor.weight;
	}

	if (totalWeight <= 0) {
		return neighbors[Math.floor(Math.random() * neighbors.length)].index;
	}

	let r = Math.random() * totalWeight;
	for (const neighbor of neighbors) {
		if ((r -= neighbor.weight) <= 0) {
			return neighbor.index;
		}
	}

	return neighbors[neighbors.length - 1].index;
}

function updateImpactFlashes(delta) {
	for (let i = impactFlashes.length - 1; i >= 0; i--) {
		impactFlashes[i].life -= delta;
		if (impactFlashes[i].life <= 0) {
			impactFlashes.splice(i, 1);
		}
	}
}

function renderFrame() {
	if (!baseImageData) return;

	const baseData = baseImageData.data;
	const outputData = outputImageData.data;

	for (let i = 0; i < totalPixels; i++) {
		const wetness = Math.min(CONFIG.wetting.saturationCap, wetMap[i]);
		const wetRatio = wetness / CONFIG.wetting.saturationCap;
		const baseIndex = i * 4;
		const highlight = highlightMap[i] * (CONFIG.shading.ambientLift + wetRatio * CONFIG.shading.specular);

		let r = baseData[baseIndex];
		let g = baseData[baseIndex + 1];
		let b = baseData[baseIndex + 2];
		const a = baseData[baseIndex + 3];

		const darken = 1 - wetRatio * CONFIG.shading.darkening;
		r *= darken;
		g *= darken * (1 - wetRatio * 0.06);
		b *= darken * (1 - wetRatio * 0.12);

		const tint = wetRatio * CONFIG.shading.coldTint;
		r -= tint * 16;
		g -= tint * 8;
		b += tint * 42;

		r += highlight * 110;
		g += highlight * 140;
		b += highlight * 170;

		outputData[baseIndex] = clamp255(r);
		outputData[baseIndex + 1] = clamp255(g);
		outputData[baseIndex + 2] = clamp255(b);
		outputData[baseIndex + 3] = a;
	}

	ctx.putImageData(outputImageData, 0, 0);
	renderOverlays();
}

function renderOverlays() {
	if (droplets.length) {
		ctx.save();
		ctx.globalCompositeOperation = 'multiply';
		ctx.lineWidth = Math.max(1, pixelRatio * 1.1);
		ctx.lineCap = 'round';

		const maxTail = fallScale * CONFIG.overlay.tailMaxRatio;
		for (const droplet of droplets) {
			const heightRatio = clamp01(droplet.height / (fallScale * CONFIG.rain.spawnHeightMax));
			const alpha = CONFIG.overlay.dropletAlpha * (0.25 + heightRatio);
			if (alpha <= 0.02) continue;
			const tail = clamp(droplet.height * 0.65, droplet.radius * 1.2, maxTail);

			ctx.strokeStyle = `rgba(25, 28, 34, ${alpha * 1.35})`;
			ctx.beginPath();
			ctx.moveTo(droplet.x, droplet.y - tail);
			ctx.lineTo(droplet.x, droplet.y);
			ctx.stroke();

			ctx.fillStyle = `rgba(12, 14, 18, ${alpha * 1.6})`;
			ctx.beginPath();
			ctx.arc(droplet.x, droplet.y, Math.max(0.8, droplet.radius * 0.38), 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.restore();
	}

	if (impactFlashes.length) {
		ctx.save();
		ctx.globalCompositeOperation = 'multiply';
		for (const flash of impactFlashes) {
			const t = clamp01(flash.life / CONFIG.overlay.flashLifeMs);
			const alpha = t * flash.strength * 0.4;
			if (alpha <= 0.01) continue;
			const radius = flash.radius * (1.2 - t * 0.6);
			const gradient = ctx.createRadialGradient(
				flash.x,
				flash.y,
				radius * 0.2,
				flash.x,
				flash.y,
				radius
			);
			gradient.addColorStop(0, `rgba(20, 24, 28, ${alpha * 0.8})`);
			gradient.addColorStop(0.7, `rgba(35, 38, 42, ${alpha * 0.5})`);
			gradient.addColorStop(1, 'rgba(60, 62, 65, 0)');
			ctx.fillStyle = gradient;
			ctx.fillRect(flash.x - radius, flash.y - radius, radius * 2, radius * 2);
		}
		ctx.restore();
	}
}

function clamp(value, min, max) {
	return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp255(value) {
	return value < 0 ? 0 : value > 255 ? 255 : value;
}

function randomRange(min, max) {
	return Math.random() * (max - min) + min;
}

function hash(x, y) {
	return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}

function fract(value) {
	return value - Math.floor(value);
}
