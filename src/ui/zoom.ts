import { Modal, type App } from 'obsidian';

/**
 * Pan and zoom one diagram. Upstream #104, and the real answer to #42 and #14 as well — a diagram
 * that is legible at reading size but too dense to read closely is a different complaint from one
 * that renders too small, and it needs a different fix.
 *
 * Operates on a CLONE. The mounted diagram keeps its own id nonce and its place in the note; this
 * gets a fresh nonce so the two copies cannot fight over `url(#...)` references (upstream #12 is
 * exactly that failure between two panes).
 */
export class ZoomModal extends Modal {
	private readonly markup: string;
	private scale = 1;
	private tx = 0;
	private ty = 0;
	private surface: HTMLElement | null = null;
	private dragging: { x: number; y: number } | null = null;

	constructor(app: App, markup: string) {
		super(app);
		this.markup = markup;
	}

	override onOpen(): void {
		this.modalEl.addClass('tikzjax-zoom-modal');
		this.titleEl.setText('Diagram');

		const surface = this.contentEl.createDiv({ cls: 'tikzjax-zoom-surface' });
		this.surface = surface;
		surface.appendChild(this.contentEl.doc.createRange().createContextualFragment(this.markup));

		const svg = surface.querySelector('svg');
		if (svg) {
			svg.removeAttribute('width');
			svg.removeAttribute('height');
		}

		// Keyboard as well as pointer. Drag-only is unusable without a pointing device, and the
		// modal is otherwise perfectly reachable by keyboard — Obsidian's Modal already traps focus
		// and closes on Escape.
		surface.tabIndex = 0;
		surface.setAttribute('role', 'application');
		surface.setAttribute('aria-label', 'Diagram, pan with the arrow keys, zoom with plus and minus');

		surface.addEventListener('wheel', (event: WheelEvent) => {
			event.preventDefault();
			this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
		});

		surface.addEventListener('pointerdown', (event: PointerEvent) => {
			this.dragging = { x: event.clientX - this.tx, y: event.clientY - this.ty };
			surface.setPointerCapture(event.pointerId);
		});
		surface.addEventListener('pointermove', (event: PointerEvent) => {
			if (!this.dragging) return;
			this.tx = event.clientX - this.dragging.x;
			this.ty = event.clientY - this.dragging.y;
			this.apply();
		});
		surface.addEventListener('pointerup', (event: PointerEvent) => {
			this.dragging = null;
			surface.releasePointerCapture(event.pointerId);
		});

		surface.addEventListener('keydown', (event: KeyboardEvent) => {
			const step = event.shiftKey ? 80 : 20;
			switch (event.key) {
				case 'ArrowLeft': this.tx += step; break;
				case 'ArrowRight': this.tx -= step; break;
				case 'ArrowUp': this.ty += step; break;
				case 'ArrowDown': this.ty -= step; break;
				case '+': case '=': this.zoomBy(1.2); return;
				case '-': case '_': this.zoomBy(1 / 1.2); return;
				case '0': this.reset(); return;
				default: return;
			}
			event.preventDefault();
			this.apply();
		});

		const footer = this.contentEl.createDiv({ cls: 'tikzjax-zoom-actions' });
		footer.createEl('button', { text: 'Reset' }).addEventListener('click', () => this.reset());
		surface.focus();
	}

	private zoomBy(factor: number): void {
		this.scale = Math.min(20, Math.max(0.2, this.scale * factor));
		this.apply();
	}

	private reset(): void {
		this.scale = 1;
		this.tx = 0;
		this.ty = 0;
		this.apply();
	}

	private apply(): void {
		const svg = this.surface?.querySelector('svg');
		if (svg instanceof SVGElement) {
			svg.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		}
	}

	override onClose(): void {
		this.contentEl.empty();
		this.surface = null;
	}
}
