/**
 * A clock the test moves by hand, behind the same `setTimeout`/`clearTimeout` seam the plugin
 * passes around. Fires in (time, insertion) order, including timers set by a firing one.
 */
export class FakeTimers {
	private now = 0;
	private nextId = 1;
	private readonly scheduled: { id: number; at: number; fn: () => void }[] = [];

	readonly setTimeout = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.scheduled.push({ id, at: this.now + ms, fn });
		return id;
	};

	readonly clearTimeout = (id: number): void => {
		const index = this.scheduled.findIndex((t) => t.id === id);
		if (index >= 0) this.scheduled.splice(index, 1);
	};

	/** The time on this clock, for a `now()` that has to agree with it. */
	readonly time = (): number => this.now;

	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let next: { id: number; at: number; fn: () => void } | undefined;
			for (const t of this.scheduled) {
				if (t.at > target) continue;
				if (next === undefined || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
			}
			if (next === undefined) {
				this.now = target;
				return;
			}
			this.scheduled.splice(this.scheduled.indexOf(next), 1);
			this.now = next.at;
			next.fn();
		}
	}

	get outstanding(): number {
		return this.scheduled.length;
	}
}
