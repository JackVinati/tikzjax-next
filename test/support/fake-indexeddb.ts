/**
 * A small in-memory IndexedDB: enough of the API for `idb` and the plugin's stores, with real
 * transaction semantics and faults on demand. There is no IndexedDB in Node, and the bugs this
 * exists to pin down are transactional — a read-modify-write split across two transactions, a
 * connection that dies under a cached handle — so a stub that answered calls one by one would pass
 * the very code those bugs live in.
 *
 * What it models, because the store's correctness depends on it:
 *   - Transactions on a database run one at a time, in the order they were created. Overlapping
 *     read-write transactions are serialised in every browser; serialising the rest is a valid
 *     schedule too.
 *   - A transaction takes requests only while it is active: in the task that created it, and while
 *     one of its requests' events is dispatched (microtasks included, which is what lets `await`
 *     work between requests). It commits once it has no request left to run.
 *   - A request that fails aborts its transaction, which rolls back everything it wrote.
 *   - Values are structured-cloned on the way in and on the way out.
 *   - Keys are strings or numbers; numbers sort first, as in IndexedDB.
 *
 * And the faults the store has to survive: a write failing with a given error (QuotaExceededError),
 * a connection closed under its owner, with or without the browser's `close` event, a WebKit-style
 * lost connection on which every request fails with UnknownError, and an open that fails outright.
 *
 * `installFakeIndexedDB()` must run before the first `idb` call in a test file: `idb` captures the
 * IDB* constructors on first use.
 */

type Key = string | number;
type Mode = 'readonly' | 'readwrite' | 'versionchange';
type NameList = string[] & { contains(name: string): boolean };

interface StoreData {
	keyPath: string | null;
	records: Map<Key, unknown>;
	indexes: Map<string, string>;
}

interface DatabaseData {
	name: string;
	version: number;
	stores: Map<string, StoreData>;
	connections: Set<FakeIDBDatabase>;
	queue: FakeIDBTransaction[];
	running: FakeIDBTransaction | null;
	/** Opens waiting for older connections to close before they can upgrade. */
	waiting: Array<() => void>;
	/** Every connection opened from now on is lost on arrival. */
	lostForGood: boolean;
}

/**
 * A macrotask, as IndexedDB delivers its events: each one runs after every microtask the previous
 * one queued, which is what keeps a transaction active across `await`s. Through a MessageChannel
 * rather than setTimeout, which Node clamps to a millisecond — a thousand-step test would take
 * seconds instead of milliseconds. Unreferenced, so a pending step never holds the worker open.
 */
const tasks: Array<() => void> = [];
const channel = new MessageChannel();
channel.port1.onmessage = () => {
	tasks.shift()?.();
};
(channel.port1 as unknown as { unref?: () => void }).unref?.();

const tick = (fn: () => void): void => {
	tasks.push(fn);
	channel.port2.postMessage(null);
};

function domError(name: string, message = name): DOMException {
	return new DOMException(message, name);
}

function isKey(value: unknown): value is Key {
	return typeof value === 'string' || (typeof value === 'number' && !Number.isNaN(value));
}

function compareKeys(a: Key, b: Key): number {
	if (typeof a === 'number' && typeof b === 'string') return -1;
	if (typeof a === 'string' && typeof b === 'number') return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

function namesOf(keys: Iterable<string>): NameList {
	const list = [...keys].sort() as NameList;
	list.contains = (name: string) => list.includes(name);
	return list;
}

function copyStores(stores: Map<string, StoreData>): Map<string, StoreData> {
	const copy = new Map<string, StoreData>();
	for (const [name, store] of stores) {
		copy.set(name, {
			keyPath: store.keyPath,
			records: new Map(store.records),
			indexes: new Map(store.indexes),
		});
	}
	return copy;
}

class FakeVersionChangeEvent extends Event {
	readonly oldVersion: number;
	readonly newVersion: number;

	constructor(type: string, oldVersion: number, newVersion: number) {
		super(type);
		this.oldVersion = oldVersion;
		this.newVersion = newVersion;
	}
}

/** Faults to inject, and a count of write requests per store. Shared by every connection. */
class Faults {
	private readonly writeErrors: Array<{ db: string; store: string | null; error: DOMException }> = [];
	private readonly writes = new Map<string, number>();

	failNextWrite(db: string, store: string | null, error: DOMException): void {
		this.writeErrors.push({ db, store, error });
	}

	/** Runs as a write request executes, so the failure aborts and rolls back its transaction. */
	beforeWrite(db: string, store: string): void {
		const at = this.writeErrors.findIndex((f) => f.db === db && (f.store === null || f.store === store));
		if (at < 0) return;
		const [fault] = this.writeErrors.splice(at, 1);
		if (fault) throw fault.error;
	}

	countWrite(db: string, store: string): void {
		const key = `${db}/${store}`;
		this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
	}

	writesTo(db: string, store: string): number {
		return this.writes.get(`${db}/${store}`) ?? 0;
	}

	reset(): void {
		this.writeErrors.length = 0;
		this.writes.clear();
	}
}

// -------------------------------------------------------------------------------------------

export class FakeIDBRequest extends EventTarget {
	result: unknown = undefined;
	error: DOMException | null = null;
	readyState: 'pending' | 'done' = 'pending';
	source: unknown = null;
	transaction: FakeIDBTransaction | null = null;
}

export class FakeIDBOpenDBRequest extends FakeIDBRequest {}

export class FakeIDBTransaction extends EventTarget {
	readonly db: FakeIDBDatabase;
	readonly mode: Mode;
	readonly scope: string[];
	error: DOMException | null = null;
	active = true;
	private state: 'queued' | 'running' | 'finished' = 'queued';
	private readonly pending: Array<{ request: FakeIDBRequest; run: () => unknown }> = [];
	private snapshot: { version: number; stores: Map<string, StoreData> } | null = null;

	constructor(db: FakeIDBDatabase, scope: string[], mode: Mode) {
		super();
		this.db = db;
		this.scope = scope;
		this.mode = mode;
		// A version change starts changing the schema before it is scheduled, in the upgrade
		// callback, so its rollback point has to be taken now.
		if (mode === 'versionchange') this.takeSnapshot();
		// Active for the rest of the task that created it, as in a browser.
		tick(() => {
			this.active = false;
		});
	}

	get objectStoreNames(): NameList {
		return namesOf(this.scope);
	}

	objectStore(name: string): FakeIDBObjectStore {
		if (this.state === 'finished') throw domError('InvalidStateError', 'The transaction has finished.');
		if (!this.scope.includes(name) || !this.db.data.stores.has(name)) {
			throw domError('NotFoundError', `No object store named ${name} in this transaction.`);
		}
		return new FakeIDBObjectStore(this, name);
	}

	abort(): void {
		this.fail(domError('AbortError', 'The transaction was aborted.'));
	}

	/** Called by stores and cursors. Throws what a browser throws for a request it will not take. */
	enqueue(request: FakeIDBRequest, run: () => unknown, write: boolean): void {
		if (this.state === 'finished' || !this.active) {
			throw domError('TransactionInactiveError', 'The transaction is not active.');
		}
		if (write && this.mode === 'readonly')
			throw domError('ReadOnlyError', 'The transaction is read-only.');
		request.transaction = this;
		request.readyState = 'pending';
		this.pending.push({ request, run });
	}

	/** The scheduler hands over the database. */
	start(): void {
		this.state = 'running';
		if (!this.snapshot) this.takeSnapshot();
		tick(() => this.step());
	}

	private takeSnapshot(): void {
		this.snapshot = { version: this.db.data.version, stores: copyStores(this.db.data.stores) };
	}

	private step(): void {
		if (this.state !== 'running') return;
		this.active = false;

		const next = this.pending.shift();
		if (!next) {
			this.state = 'finished';
			this.dispatchEvent(new Event('complete'));
			this.db.scheduler.finished(this);
			return;
		}

		const { request } = next;
		try {
			if (this.db.lost) throw domError('UnknownError', 'Connection to Indexed Database server lost.');
			request.result = next.run();
			request.readyState = 'done';
			this.active = true;
			request.dispatchEvent(new Event('success'));
		} catch (thrown) {
			const error = thrown instanceof DOMException ? thrown : domError('UnknownError', String(thrown));
			request.error = error;
			request.readyState = 'done';
			this.active = true;
			const event = new Event('error', { cancelable: true });
			request.dispatchEvent(event);
			if (!event.defaultPrevented) {
				this.fail(error);
				return;
			}
		}
		tick(() => this.step());
	}

	private fail(error: DOMException): void {
		if (this.state === 'finished') return;
		const wasRunning = this.state === 'running';
		this.state = 'finished';
		this.error = error;
		if (wasRunning && this.snapshot) {
			this.db.data.version = this.snapshot.version;
			this.db.data.stores = this.snapshot.stores;
		}
		for (const { request } of this.pending.splice(0)) {
			request.error = domError('AbortError', 'The transaction was aborted.');
			request.readyState = 'done';
			request.dispatchEvent(new Event('error', { cancelable: true }));
		}
		this.dispatchEvent(new Event('abort'));
		if (wasRunning) this.db.scheduler.finished(this);
		else this.db.scheduler.remove(this);
	}
}

/** One per database: the transaction queue lives in its data, shared by all its connections. */
class Scheduler {
	private readonly data: DatabaseData;

	constructor(data: DatabaseData) {
		this.data = data;
	}

	add(tx: FakeIDBTransaction, first = false): void {
		if (first) this.data.queue.unshift(tx);
		else this.data.queue.push(tx);
		this.pump();
	}

	remove(tx: FakeIDBTransaction): void {
		const at = this.data.queue.indexOf(tx);
		if (at >= 0) this.data.queue.splice(at, 1);
	}

	finished(tx: FakeIDBTransaction): void {
		if (this.data.running === tx) this.data.running = null;
		this.pump();
	}

	private pump(): void {
		if (this.data.running) return;
		const next = this.data.queue.shift();
		if (!next) return;
		this.data.running = next;
		next.start();
	}
}

// -------------------------------------------------------------------------------------------

export class FakeIDBDatabase extends EventTarget {
	readonly name: string;
	readonly version: number;
	readonly data: DatabaseData;
	readonly scheduler: Scheduler;
	readonly faults: Faults;
	closed = false;
	lost = false;
	upgrade: FakeIDBTransaction | null = null;

	constructor(data: DatabaseData, version: number, scheduler: Scheduler, faults: Faults) {
		super();
		this.data = data;
		this.name = data.name;
		this.version = version;
		this.scheduler = scheduler;
		this.faults = faults;
	}

	get objectStoreNames(): NameList {
		return namesOf(this.data.stores.keys());
	}

	transaction(names: string | string[], mode: 'readonly' | 'readwrite' = 'readonly'): FakeIDBTransaction {
		if (this.closed) throw domError('InvalidStateError', 'The database connection is closing.');
		if (this.upgrade) throw domError('InvalidStateError', 'A version change transaction is running.');
		const scope = [...new Set(typeof names === 'string' ? [names] : names)];
		if (scope.length === 0) throw domError('InvalidAccessError', 'The scope is empty.');
		for (const name of scope) {
			if (!this.data.stores.has(name))
				throw domError('NotFoundError', `No object store named ${name}.`);
		}
		const tx = new FakeIDBTransaction(this, scope, mode);
		this.scheduler.add(tx);
		return tx;
	}

	createObjectStore(name: string, options?: { keyPath?: string }): FakeIDBObjectStore {
		const upgrade = this.requireUpgrade();
		if (this.data.stores.has(name)) throw domError('ConstraintError', `${name} already exists.`);
		this.data.stores.set(name, {
			keyPath: options?.keyPath ?? null,
			records: new Map(),
			indexes: new Map(),
		});
		upgrade.scope.push(name);
		return new FakeIDBObjectStore(upgrade, name);
	}

	deleteObjectStore(name: string): void {
		this.requireUpgrade();
		if (!this.data.stores.delete(name)) throw domError('NotFoundError', `No object store named ${name}.`);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.data.connections.delete(this);
		for (const resume of this.data.waiting.splice(0)) resume();
	}

	private requireUpgrade(): FakeIDBTransaction {
		if (!this.upgrade) throw domError('InvalidStateError', 'Not in a version change transaction.');
		return this.upgrade;
	}
}

export class FakeIDBObjectStore {
	readonly transaction: FakeIDBTransaction;
	readonly name: string;

	constructor(transaction: FakeIDBTransaction, name: string) {
		this.transaction = transaction;
		this.name = name;
	}

	private get data(): StoreData {
		const store = this.transaction.db.data.stores.get(this.name);
		if (!store) throw domError('InvalidStateError', `${this.name} no longer exists.`);
		return store;
	}

	get keyPath(): string | null {
		return this.data.keyPath;
	}

	get indexNames(): NameList {
		return namesOf(this.data.indexes.keys());
	}

	get(key: Key): FakeIDBRequest {
		return this.request(false, () => structuredClone(this.data.records.get(key)));
	}

	count(): FakeIDBRequest {
		return this.request(false, () => this.data.records.size);
	}

	put(value: unknown, key?: Key): FakeIDBRequest {
		const clone = structuredClone(value);
		return this.request(true, () => {
			const resolved = this.keyFor(clone, key);
			this.transaction.db.faults.beforeWrite(this.transaction.db.name, this.name);
			this.data.records.set(resolved, clone);
			return resolved;
		});
	}

	delete(key: Key): FakeIDBRequest {
		return this.request(true, () => {
			this.data.records.delete(key);
			return undefined;
		});
	}

	clear(): FakeIDBRequest {
		return this.request(true, () => {
			this.data.records.clear();
			return undefined;
		});
	}

	openCursor(): FakeIDBRequest {
		const request = new FakeIDBRequest();
		const cursor = new FakeIDBCursorWithValue(this, null, request);
		return this.enqueue(request, false, () => cursor.moveAfter(null));
	}

	index(name: string): FakeIDBIndex {
		if (!this.data.indexes.has(name)) throw domError('NotFoundError', `No index named ${name}.`);
		return new FakeIDBIndex(this, name);
	}

	createIndex(name: string, keyPath: string): FakeIDBIndex {
		this.requireVersionChange();
		this.data.indexes.set(name, keyPath);
		return new FakeIDBIndex(this, name);
	}

	deleteIndex(name: string): void {
		this.requireVersionChange();
		this.data.indexes.delete(name);
	}

	/** Records in iteration order: by primary key, or by index key and then primary key. */
	entries(index: string | null): Array<{ key: Key; primaryKey: Key; value: unknown }> {
		const out: Array<{ key: Key; primaryKey: Key; value: unknown }> = [];
		const path = index === null ? null : (this.data.indexes.get(index) ?? null);
		for (const [primaryKey, value] of this.data.records) {
			if (path === null) {
				out.push({ key: primaryKey, primaryKey, value });
				continue;
			}
			const indexed = (value as Record<string, unknown> | null)?.[path];
			if (isKey(indexed)) out.push({ key: indexed, primaryKey, value });
		}
		return out.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.primaryKey, b.primaryKey));
	}

	enqueue(request: FakeIDBRequest, write: boolean, run: () => unknown): FakeIDBRequest {
		request.source = this;
		this.transaction.enqueue(request, run, write);
		return request;
	}

	private request(write: boolean, run: () => unknown): FakeIDBRequest {
		const request = this.enqueue(new FakeIDBRequest(), write, run);
		if (write) this.transaction.db.faults.countWrite(this.transaction.db.name, this.name);
		return request;
	}

	private keyFor(value: unknown, key: Key | undefined): Key {
		const path = this.data.keyPath;
		const resolved = path === null ? key : (value as Record<string, unknown> | null)?.[path];
		if (!isKey(resolved)) throw domError('DataError', 'The record has no valid key.');
		return resolved;
	}

	private requireVersionChange(): void {
		if (this.transaction.mode !== 'versionchange') {
			throw domError('InvalidStateError', 'Not in a version change transaction.');
		}
	}
}

export class FakeIDBIndex {
	readonly objectStore: FakeIDBObjectStore;
	readonly name: string;

	constructor(objectStore: FakeIDBObjectStore, name: string) {
		this.objectStore = objectStore;
		this.name = name;
	}

	openCursor(): FakeIDBRequest {
		const request = new FakeIDBRequest();
		const cursor = new FakeIDBCursorWithValue(this.objectStore, this.name, request);
		return this.objectStore.enqueue(request, false, () => cursor.moveAfter(null));
	}
}

export class FakeIDBCursor {
	readonly source: FakeIDBObjectStore;
	readonly request: FakeIDBRequest;
	private readonly index: string | null;
	key: Key | undefined = undefined;
	primaryKey: Key | undefined = undefined;
	value: unknown = undefined;

	constructor(source: FakeIDBObjectStore, index: string | null, request: FakeIDBRequest) {
		this.source = source;
		this.index = index;
		this.request = request;
	}

	/**
	 * Move to the first record after `after` (or the first of all), reading the store as it is NOW,
	 * so a record deleted behind the cursor is simply not there. Returns null at the end.
	 */
	moveAfter(after: { key: Key; primaryKey: Key } | null): FakeIDBCursor | null {
		const next = this.source.entries(this.index).find((e) => {
			if (after === null) return true;
			const byKey = compareKeys(e.key, after.key);
			return byKey > 0 || (byKey === 0 && compareKeys(e.primaryKey, after.primaryKey) > 0);
		});
		if (!next) return null;
		this.key = next.key;
		this.primaryKey = next.primaryKey;
		this.value = structuredClone(next.value);
		return this;
	}

	continue(): void {
		const key = this.key;
		const primaryKey = this.primaryKey;
		const at = key === undefined || primaryKey === undefined ? null : { key, primaryKey };
		this.source.transaction.enqueue(this.request, () => this.moveAfter(at), false);
	}

	advance(count: number): void {
		for (let i = 0; i < count; i++) this.continue();
	}

	continuePrimaryKey(): void {
		throw domError('NotSupportedError', 'Not implemented by the fake.');
	}

	delete(): FakeIDBRequest {
		const primaryKey = this.primaryKey;
		if (primaryKey === undefined)
			throw domError('InvalidStateError', 'The cursor has no current record.');
		return this.source.delete(primaryKey);
	}
}

export class FakeIDBCursorWithValue extends FakeIDBCursor {}

// -------------------------------------------------------------------------------------------

export class FakeIndexedDB {
	private readonly byName = new Map<string, DatabaseData>();
	private readonly schedulers = new Map<string, Scheduler>();
	private readonly failingOpens = new Set<string>();
	private readonly faults = new Faults();
	/** How many times each database has been asked to open. */
	readonly opens = new Map<string, number>();

	open(name: string, version?: number): FakeIDBOpenDBRequest {
		const request = new FakeIDBOpenDBRequest();
		this.opens.set(name, (this.opens.get(name) ?? 0) + 1);
		tick(() => this.runOpen(request, name, version));
		return request;
	}

	databases(): Promise<Array<{ name: string; version: number }>> {
		return Promise.resolve([...this.byName.values()].map((d) => ({ name: d.name, version: d.version })));
	}

	// --- faults and inspection ----------------------------------------------------------------

	/** Every later open of `name` fails, as an open does when storage is unavailable. */
	failOpens(name: string): void {
		this.failingOpens.add(name);
	}

	/** The next write to `store` (to any store, if null) in `db` fails with `error`. */
	failNextWrite(db: string, store: string | null, error: DOMException): void {
		this.faults.failNextWrite(db, store, error);
	}

	/**
	 * Close every open connection to `name` under its owner. With `terminated`, the browser also
	 * fires `close` on each, as it does when it shuts a connection abnormally; without it, the
	 * owner only finds out when its next transaction throws InvalidStateError.
	 */
	closeConnections(name: string, terminated: boolean): void {
		for (const connection of this.byName.get(name)?.connections ?? []) {
			connection.close();
			if (terminated) connection.dispatchEvent(new Event('close'));
		}
	}

	/**
	 * WebKit's "Connection to Indexed Database server lost": the handle still opens transactions,
	 * and every request on it fails with UnknownError. With `forGood`, connections opened later are
	 * lost too, as when the storage process itself is gone.
	 */
	loseConnections(name: string, forGood = false): void {
		const data = this.byName.get(name);
		if (!data) return;
		for (const connection of data.connections) connection.lost = true;
		data.lostForGood = forGood;
	}

	/** A copy of one store's records, for assertions. */
	records(db: string, store: string): Map<Key, unknown> {
		return new Map(this.byName.get(db)?.stores.get(store)?.records ?? []);
	}

	/** Write requests made against `store` since the last reset. */
	writesTo(db: string, store: string): number {
		return this.faults.writesTo(db, store);
	}

	/** Resolves once nothing has been queued or running for a few turns. For fire-and-forget callers. */
	async idle(): Promise<void> {
		for (let quiet = 0; quiet < 3;) {
			await new Promise<void>((resolve) => tick(resolve));
			const busy = [...this.byName.values()].some((d) => d.running !== null || d.queue.length > 0);
			quiet = busy ? 0 : quiet + 1;
		}
	}

	reset(): void {
		for (const data of this.byName.values()) {
			for (const connection of data.connections) connection.close();
		}
		this.byName.clear();
		this.schedulers.clear();
		this.failingOpens.clear();
		this.opens.clear();
		this.faults.reset();
	}

	// ------------------------------------------------------------------------------------------

	private runOpen(request: FakeIDBOpenDBRequest, name: string, version: number | undefined): void {
		if (this.failingOpens.has(name)) {
			this.reject(request, domError('UnknownError', 'Internal error opening backing store.'));
			return;
		}

		const data = this.byName.get(name) ?? {
			name,
			version: 0,
			stores: new Map<string, StoreData>(),
			connections: new Set<FakeIDBDatabase>(),
			queue: [],
			running: null,
			waiting: [],
			lostForGood: false,
		};
		const target = version ?? Math.max(1, data.version);
		if (target < data.version) {
			this.reject(request, domError('VersionError', `Version ${target} is less than ${data.version}.`));
			return;
		}
		this.byName.set(name, data);
		let scheduler = this.schedulers.get(name);
		if (!scheduler) {
			scheduler = new Scheduler(data);
			this.schedulers.set(name, scheduler);
		}

		if (target > data.version && data.connections.size > 0) {
			for (const other of data.connections) {
				other.dispatchEvent(new FakeVersionChangeEvent('versionchange', data.version, target));
			}
			if (data.connections.size > 0) {
				request.dispatchEvent(new FakeVersionChangeEvent('blocked', data.version, target));
				data.waiting.push(() => this.runOpen(request, name, version));
				return;
			}
		}

		const connection = new FakeIDBDatabase(data, target, scheduler, this.faults);
		connection.lost = data.lostForGood;
		data.connections.add(connection);
		request.result = connection;

		if (target === data.version) {
			request.readyState = 'done';
			request.dispatchEvent(new Event('success'));
			return;
		}

		const oldVersion = data.version;
		const upgrade = new FakeIDBTransaction(connection, [...data.stores.keys()], 'versionchange');
		connection.upgrade = upgrade;
		request.transaction = upgrade;
		upgrade.addEventListener('complete', () => {
			connection.upgrade = null;
			request.transaction = null;
			request.readyState = 'done';
			request.dispatchEvent(new Event('success'));
		});
		upgrade.addEventListener('abort', () => {
			connection.upgrade = null;
			connection.close();
			request.transaction = null;
			request.result = undefined;
			this.reject(request, upgrade.error ?? domError('AbortError'));
		});
		data.version = target;
		request.dispatchEvent(new FakeVersionChangeEvent('upgradeneeded', oldVersion, target));
		scheduler.add(upgrade, true);
	}

	private reject(request: FakeIDBRequest, error: DOMException): void {
		request.error = error;
		request.readyState = 'done';
		request.dispatchEvent(new Event('error', { cancelable: true }));
	}
}

/**
 * Put the fake on the global object, under the names `idb` looks for. Returns the factory, whose
 * extra methods inject faults and inspect what was written.
 */
export function installFakeIndexedDB(): FakeIndexedDB {
	const factory = new FakeIndexedDB();
	const globals = globalThis as unknown as Record<string, unknown>;
	globals['indexedDB'] = factory;
	globals['IDBFactory'] = FakeIndexedDB;
	globals['IDBRequest'] = FakeIDBRequest;
	globals['IDBOpenDBRequest'] = FakeIDBOpenDBRequest;
	globals['IDBDatabase'] = FakeIDBDatabase;
	globals['IDBTransaction'] = FakeIDBTransaction;
	globals['IDBObjectStore'] = FakeIDBObjectStore;
	globals['IDBIndex'] = FakeIDBIndex;
	globals['IDBCursor'] = FakeIDBCursor;
	globals['IDBCursorWithValue'] = FakeIDBCursorWithValue;
	return factory;
}
