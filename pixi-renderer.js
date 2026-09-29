class PixiCanvas {
	constructor(width, height, app) {
		this.app = app;
		this.root = new PIXI.Container();
		this.cache = null;
		this.style = {};
		this._width = width;
		this._height = height;
		this.context = null;
		this.references = new Set();
	}

	get width() {
		return this._width;
	}

	set width(value) {
		this._width = value;
		this.reset();
	}

	get height() {
		return this._height;
	}

	set height(value) {
		this._height = value;
		this.reset();
	}

	getContext(type) {
		if (type !== '2d') return null;
		if (!this.context) this.context = new PixiContext(this);
		return this.context;
	}

	addEventListener(type, handler, options) {
		this.app.view.addEventListener(type, handler, options);
	}

	getAttribute(name) {
		return this.app.view.getAttribute(name);
	}

	setAttribute(name, value) {
		this.app.view.setAttribute(name, value);
	}

	removeAttribute(name) {
		this.app.view.removeAttribute(name);
	}

	getTexture() {
		if (!this.cache) {
			let resolution = this.app.renderer.resolution;
			this.cache = this.app.renderer.generateTexture(this.root, {
				region: new PIXI.Rectangle(0, 0, this.width / resolution, this.height / resolution),
				resolution
			});
			this.cache._pixiRefCount = 0;
			this.cache._pixiRetired = false;
		}
		return this.cache;
	}

	invalidateTexture() {
		if (this.cache) {
			this.cache._pixiRetired = true;
			this.queueTexture(this.cache);
			this.cache = null;
		}
	}

	queueTexture(texture) {
		if (texture._pixiRetired && texture._pixiRefCount === 0) {
			if (!this.app.pixitextures) this.app.pixitextures = [];
			this.app.pixitextures.push(texture);
		}
	}

	reset() {
		this.clear();
		if (this.context) this.context.reset();
	}

	clear() {
		this.invalidateTexture();
		for (let texture of this.references) {
			texture._pixiRefCount--;
			this.queueTexture(texture);
		}
		this.references.clear();
		this.root.removeChildren().forEach(child => child.destroy({ children: true }));
	}
}

class PixiContext {
	constructor(surface) {
		this.surface = surface;
		this.root = surface.root;
		this.parent = this.root;
		this.stack = [];
		this.path = [];
		this.state = {
			fillStyle: '#000000',
			strokeStyle: '#000000',
			globalAlpha: 1,
			lineWidth: 1,
			font: '10px sans-serif',
			textAlign: 'left',
			textBaseline: 'alphabetic',
			globalCompositeOperation: 'source-over',
			matrix: new PIXI.Matrix()
		};
	}

	reset() {
		this.parent = this.surface.root;
		this.root = this.surface.root;
		this.stack = [];
		this.path = [];
		this.state = {
			fillStyle: '#000000',
			strokeStyle: '#000000',
			globalAlpha: 1,
			lineWidth: 1,
			font: '10px sans-serif',
			textAlign: 'left',
			textBaseline: 'alphabetic',
			globalCompositeOperation: 'source-over',
			matrix: new PIXI.Matrix()
		};
	}

	color(value) {
		let text = String(value);
		let alpha = 1;
		let match = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
		if (match) {
			alpha = match[4] === undefined ? 1 : Number(match[4]);
			return {
				color: (Math.round(Number(match[1])) << 16) | (Math.round(Number(match[2])) << 8) | Math.round(Number(match[3])),
				alpha
			};
		}
		if (/^#[\da-f]{8}$/i.test(text)) {
			alpha = parseInt(text.slice(7), 16) / 255;
			text = text.slice(0, 7);
		}
		return { color: PIXI.utils.string2hex(text), alpha };
	}

	textStyle() {
		let match = this.state.font.match(/([\d.]+)px\s+(.+)/);
		return {
			fontFamily: match ? match[2] : 'sans-serif',
			fontSize: match ? Number(match[1]) : 10,
			fontWeight: /\bbold\b/i.test(this.state.font) ? 'bold' : 'normal',
			fontStyle: /\bitalic\b/i.test(this.state.font) ? 'italic' : 'normal'
		};
	}

	getTextTexture(value, fill) {
		let texts = this.surface.app.pixiTextCache;
		let text = String(value);
		let style = { ...this.textStyle(), fill };
		let key = JSON.stringify([text, style]);
		if (texts.has(key)) {
			let cached = texts.get(key);
			texts.delete(key);
			texts.set(key, cached);
			return cached.texture;
		}
		let cached = new PIXI.Text(text, style);
		cached.resolution = this.surface.app.renderer.resolution;
		cached.updateText();
		texts.set(key, cached);
		if (texts.size > 384) {
			let oldest = texts.entries().next().value;
			texts.delete(oldest[0]);
			this.surface.app.pixiTextRetired.push(oldest[1]);
		}
		return cached.texture;
	}

	add(node, alpha) {
		node.alpha = alpha;
		node.blendMode = this.state.globalCompositeOperation === 'destination-in'
			? PIXI.BLEND_MODES.DST_IN
			: this.state.globalCompositeOperation === 'destination-out'
				? PIXI.BLEND_MODES.DST_OUT
				: PIXI.BLEND_MODES.NORMAL;
		let group = new PIXI.Container();
		group.alpha = this.state.globalAlpha;
		group.transform.setFromMatrix(this.state.matrix.clone());
		group.addChild(node);
		this.parent.addChild(group);
		this.surface.invalidateTexture();
		return node;
	}

	graphics(fill, stroke, hole) {
		let graphics = new PIXI.Graphics();
		let subpaths = 0;
		let holeOpen = false;
		if (fill) {
			let style = this.color(this.state.fillStyle);
			graphics.beginFill(style.color, style.alpha);
		}
		if (stroke) {
			let style = this.color(this.state.strokeStyle);
			graphics.lineStyle(this.state.lineWidth, style.color, style.alpha);
		}
		for (let item of this.path) {
			switch (item[0]) {
				case 'moveTo':
					if (hole && subpaths === 1) {
						graphics.beginHole();
						holeOpen = true;
					}
					subpaths++;
					graphics.moveTo(item[1], item[2]);
					break;
				case 'lineTo': graphics.lineTo(item[1], item[2]); break;
				case 'arc': graphics.arc(item[1], item[2], item[3], item[4], item[5], item[6]); break;
				case 'rect': graphics.drawRect(item[1], item[2], item[3], item[4]); break;
				case 'roundRect': {
					let [x, y, width, height, radii] = item.slice(1);
					let corners = radii.length === 1
						? [radii[0], radii[0], radii[0], radii[0]]
						: radii.length === 2
							? [radii[0], radii[1], radii[0], radii[1]]
							: radii.length === 3
								? [radii[0], radii[1], radii[2], radii[1]]
								: radii;
					let limit = Math.min(Math.abs(width), Math.abs(height)) / 2;
					corners = corners.map(value => Math.min(value, limit));
					graphics.moveTo(x + corners[0], y);
					graphics.lineTo(x + width - corners[1], y);
					if (corners[1]) graphics.arc(x + width - corners[1], y + corners[1], corners[1], -Math.PI / 2, 0);
					graphics.lineTo(x + width, y + height - corners[2]);
					if (corners[2]) graphics.arc(x + width - corners[2], y + height - corners[2], corners[2], 0, Math.PI / 2);
					graphics.lineTo(x + corners[3], y + height);
					if (corners[3]) graphics.arc(x + corners[3], y + height - corners[3], corners[3], Math.PI / 2, Math.PI);
					graphics.lineTo(x, y + corners[0]);
					if (corners[0]) graphics.arc(x + corners[0], y + corners[0], corners[0], Math.PI, Math.PI * 1.5);
					graphics.closePath();
					break;
				}
				case 'quadraticCurveTo': graphics.quadraticCurveTo(item[1], item[2], item[3], item[4]); break;
				case 'closePath':
					graphics.closePath();
					if (holeOpen) {
						graphics.endHole();
						holeOpen = false;
					}
					break;
			}
		}
		return graphics;
	}

	beginPath() {
		this.path = [];
	}

	moveTo(x, y) {
		this.path.push(['moveTo', x, y]);
	}

	lineTo(x, y) {
		this.path.push(['lineTo', x, y]);
	}

	arc(x, y, radius, start, end, anticlockwise) {
		this.path.push(['arc', x, y, radius, start, end, anticlockwise]);
	}

	quadraticCurveTo(x1, y1, x2, y2) {
		this.path.push(['quadraticCurveTo', x1, y1, x2, y2]);
	}

	rect(x, y, width, height) {
		this.path.push(['rect', x, y, width, height]);
	}

	roundRect(x, y, width, height, radius) {
		let radii = Array.isArray(radius) ? radius : [radius];
		this.path.push(['roundRect', x, y, width, height, radii]);
	}

	closePath() {
		this.path.push(['closePath']);
	}

	fill() {
		let graphics = this.graphics(true, false);
		graphics.endFill();
		this.add(graphics, 1);
	}

	stroke() {
		this.add(this.graphics(false, true), 1);
	}

	fillRect(x, y, width, height) {
		let style = this.color(this.state.fillStyle);
		let graphics = new PIXI.Graphics();
		graphics.beginFill(style.color, style.alpha).drawRect(x, y, width, height).endFill();
		this.add(graphics, 1);
	}

	strokeRect(x, y, width, height) {
		let style = this.color(this.state.strokeStyle);
		let graphics = new PIXI.Graphics();
		graphics.lineStyle(this.state.lineWidth, style.color, style.alpha).drawRect(x, y, width, height);
		this.add(graphics, 1);
	}

	clearRect() {
		this.surface.clear();
		this.root = this.surface.root;
		this.parent = this.root;
	}

	fillText(value, x, y, maxWidth) {
		let style = this.color(this.state.fillStyle);
		let text = new PIXI.Sprite(this.getTextTexture(value, style.color));
		text.alpha = style.alpha;
		text.anchor.x = this.state.textAlign === 'center' ? 0.5 : this.state.textAlign === 'right' ? 1 : 0;
		text.anchor.y = this.state.textBaseline === 'middle' ? 0.5 : this.state.textBaseline === 'bottom' ? 1 : this.state.textBaseline === 'alphabetic' ? 0.8 : 0;
		if (maxWidth !== undefined && text.width > maxWidth) text.scale.x = maxWidth / text.width;
		text.position.set(x, y);
		this.add(text, 1);
	}

	measureText(value) {
		let measures = this.surface.app.pixiTextMeasures;
		let text = String(value);
		let style = this.textStyle();
		let key = JSON.stringify([text, style]);
		if (!measures.has(key)) {
			measures.set(key, PIXI.TextMetrics.measureText(text, new PIXI.TextStyle(style)).width);
			if (measures.size > 2048) measures.delete(measures.keys().next().value);
		}
		return { width: measures.get(key) };
	}

	drawImage(source, ...args) {
		let texture = source instanceof PixiCanvas ? source.getTexture() : source;
		if (source instanceof PixiCanvas && !this.surface.references.has(texture)) {
			texture._pixiRefCount++;
			this.surface.references.add(texture);
		}
		if (!(texture instanceof PIXI.Texture)) texture = PIXI.Texture.from(texture);
		let sprite = new PIXI.Sprite(texture);
		let sx = 0;
		let sy = 0;
		let sw = texture.width;
		let sh = texture.height;
		let dx;
		let dy;
		let dw;
		let dh;
		if (args.length === 2) {
			[dx, dy] = args;
			dw = sw;
			dh = sh;
		} else if (args.length === 4) {
			[dx, dy, dw, dh] = args;
		} else {
			[sx, sy, sw, sh, dx, dy, dw, dh] = args;
			sprite.texture = new PIXI.Texture(texture.baseTexture, new PIXI.Rectangle(sx, sy, sw, sh));
		}
		sprite.position.set(dx, dy);
		sprite.width = dw;
		sprite.height = dh;
		this.add(sprite, 1);
	}

	save() {
		this.stack.push({ state: { ...this.state, matrix: this.state.matrix.clone() }, parent: this.parent });
	}

	restore() {
		let saved = this.stack.pop();
		if (saved) {
			this.state = saved.state;
			this.parent = saved.parent;
		}
	}

	translate(x, y) {
		this.state.matrix.append(new PIXI.Matrix(1, 0, 0, 1, x, y));
	}

	scale(x, y) {
		this.state.matrix.append(new PIXI.Matrix(x, 0, 0, y, 0, 0));
	}

	rotate(angle) {
		let cosine = Math.cos(angle);
		let sine = Math.sin(angle);
		this.state.matrix.append(new PIXI.Matrix(cosine, sine, -sine, cosine, 0, 0));
	}

	transform(a, b, c, d, e, f) {
		this.state.matrix.append(new PIXI.Matrix(a, b, c, d, e, f));
	}

	setTransform(a, b, c, d, e, f) {
		this.state.matrix = a instanceof PIXI.Matrix ? a.clone() : new PIXI.Matrix(a, b, c, d, e, f);
	}

	clip() {
		let mask = this.graphics(true, false, true);
		mask.endFill();
		mask.renderable = false;
		mask.transform.setFromMatrix(this.state.matrix.clone());
		this.parent.addChild(mask);
		let group = new PIXI.Container();
		group.mask = mask;
		this.parent.addChild(group);
		this.parent = group;
		this.surface.invalidateTexture();
	}
}

for (let name of ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalCompositeOperation']) {
	Object.defineProperty(PixiContext.prototype, name, {
		get() { return this.state[name]; },
		set(value) { this.state[name] = value; }
	});
}

window.PixiCanvas = PixiCanvas;